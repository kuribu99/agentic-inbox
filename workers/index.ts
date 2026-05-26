// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import PostalMime from "postal-mime";
import { z } from "zod";
import { storeAttachments } from "./lib/attachments";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildThreadingHeaders,
	listMailboxes,
} from "./lib/email-helpers";
import { SendEmailRequestSchema } from "./lib/schemas";
import { handleReplyEmail, handleForwardEmail } from "./routes/reply-forward";
import { Folders } from "../shared/folders";
import type { Env } from "./types";
import { requireMailbox, type MailboxContext } from "./lib/mailbox";
import {
	DEFAULT_GMAIL_SCOPES,
	buildGmailAuthUrl,
	exchangeGmailCode,
	getGmailProfile,
} from "./providers/gmail";
import {
	DEFAULT_OUTLOOK_SCOPES,
	buildOutlookAuthUrl,
	exchangeOutlookCode,
	getOutlookProfile,
} from "./providers/outlook";
import {
	ConnectionProvider,
	ensureConnections,
	generateConnectionId,
	loadMailboxSettings,
	removeConnection,
	saveMailboxSettings,
	upsertConnection,
} from "./lib/connections";
import { decryptJson, encryptJson } from "./lib/crypto";
import { sendOutgoingEmail } from "./lib/outgoing";
import { bufferFromRequest, ingestRawEmail, streamToArrayBuffer } from "./lib/ingest";
import { decodeState, encodeState, generatePkcePair } from "./lib/oauth";
import { syncConnection } from "./sync";

type AppContext = Context<MailboxContext>;

// -- Request body schemas (kept for validation) ---------------------

const CreateMailboxBody = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	settings: z.record(z.any()).optional(), // unvalidated — agentSystemPrompt goes straight to AI
});

const DraftBody = z.object({
	to: z.string().optional(),
	cc: z.string().optional(),
	bcc: z.string().optional(),
	subject: z.string().optional(),
	body: z.string(),
	in_reply_to: z.string().optional(),
	thread_id: z.string().optional(),
	draft_id: z.string().optional(),
});

const CreateConnectionBody = z.object({
	provider: z.enum(["gmail", "outlook", "imap", "smtp", "lark"]),
	email: z.string().email(),
	displayName: z.string().optional(),
	sendMode: z.enum(["cloudflare", "provider"]).optional(),
	scopes: z.array(z.string()).optional(),
	imap: z
		.object({
			host: z.string().min(1),
			port: z.coerce.number().int().min(1),
			username: z.string().min(1),
			password: z.string().min(1),
			useTLS: z.boolean().default(true),
		})
		.optional(),
});

// -- Helpers --------------------------------------------------------

function slugify(text: string) { // can return "" for non-alphanumeric input
	return text.toString().toLowerCase()
		.replace(/\s+/g, "-").replace(/[^\w-]+/g, "")
		.replace(/--+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

function intQuery(c: AppContext, key: string): number | undefined {
	const v = c.req.query(key);
	if (!v) return undefined;
	const n = Number(v);
	return Number.isNaN(n) ? undefined : n;
}

function boolQuery(c: AppContext, key: string): boolean | undefined {
	const v = c.req.query(key);
	if (v === undefined || v === "") return undefined;
	return v === "true" || v === "1";
}

function getBaseUrl(c: AppContext) {
	return c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
}

// -- App & middleware -----------------------------------------------

const app = new Hono<MailboxContext>();
app.use("/api/*", cors({
	origin: (origin) => {
		// Same-origin requests have no Origin header — allow them.
		if (!origin) return origin;
		// In development, allow localhost for Vite dev server.
		try {
			const url = new URL(origin);
			if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return origin;
		} catch { /* invalid origin */ }
		// Block all other cross-origin requests. The app is served from the
		// same origin as the API, so legitimate browser requests never send
		// an Origin header. Returning undefined omits Access-Control-Allow-Origin.
		return undefined;
	},
}));
app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);

// -- Config ---------------------------------------------------------

app.get("/api/v1/config", (c) => {
	const domainsRaw = c.env.DOMAINS || "";
	const domains = domainsRaw.split(",").map((d) => d.trim()).filter(Boolean);
	const emailAddresses = c.env.EMAIL_ADDRESSES ?? [];
	return c.json({ domains, emailAddresses });
});

// -- Mailboxes ------------------------------------------------------

app.get("/api/v1/mailboxes", async (c) => {
	const allMailboxes = await listMailboxes(c.env.BUCKET);
	return c.json(allMailboxes.map((m) => ({ ...m, name: m.id })));
});

app.post("/api/v1/mailboxes", async (c) => {
	const { name, settings, email: rawEmail } = CreateMailboxBody.parse(await c.req.json());
	const email = rawEmail.toLowerCase();
	const allowedAddresses = (c.env.EMAIL_ADDRESSES ?? []) as string[];
	if (allowedAddresses.length > 0 && !allowedAddresses.map((a) => a.toLowerCase()).includes(email)) {
		return c.json({ error: "Mailbox creation is restricted to configured EMAIL_ADDRESSES" }, 403);
	}
	const key = `mailboxes/${email}.json`;
	if (await c.env.BUCKET.head(key)) return c.json({ error: "Mailbox already exists" }, 409);
	const defaultSettings = { fromName: name, forwarding: { enabled: false, email: "" }, signature: { enabled: false, text: "" }, autoReply: { enabled: false, subject: "", message: "" } };
	const finalSettings = { ...defaultSettings, ...settings };
	await c.env.BUCKET.put(key, JSON.stringify(finalSettings));
	const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(email));
	await stub.getFolders();
	return c.json({ id: email, email, name, settings: finalSettings }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const obj = await c.env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return c.json({ error: "Not found" }, 404);
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings: await obj.json() });
});

app.put("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { settings } = (await c.req.json()) as { settings: Record<string, unknown> };
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	await c.env.BUCKET.put(key, JSON.stringify(settings));
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings });
});

app.delete("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	await c.env.BUCKET.delete(key); // TODO: also delete DO data and R2 attachment blobs
	return c.body(null, 204);
});

// -- Connections ----------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/connections", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const settings = await loadMailboxSettings(c.env.BUCKET, mailboxId);
	return c.json(ensureConnections(settings));
});

app.post("/api/v1/mailboxes/:mailboxId/connections", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const body = CreateConnectionBody.parse(await c.req.json());
	const settings = await loadMailboxSettings(c.env.BUCKET, mailboxId);
	const connectionId = generateConnectionId(body.provider as ConnectionProvider);
	const now = new Date().toISOString();

	const connection = {
		id: connectionId,
		provider: body.provider,
		email: body.email,
		displayName: body.displayName,
		status: body.provider === "gmail" || body.provider === "outlook" ? "pending" : "connected",
		sendMode:
			body.sendMode ??
			(body.provider === "gmail" || body.provider === "outlook"
				? "provider"
				: "cloudflare"),
		scopes:
			body.scopes ??
			(body.provider === "gmail"
				? DEFAULT_GMAIL_SCOPES
				: body.provider === "outlook"
					? DEFAULT_OUTLOOK_SCOPES
					: undefined),
		createdAt: now,
		updatedAt: now,
		lastError: null,
	};

	let response: Record<string, unknown> = { connection };

	if (body.provider === "gmail" || body.provider === "outlook") {
		const { verifier, challenge } = await generatePkcePair();
		const statePayload = {
			mailboxId,
			connectionId,
			provider: body.provider,
			codeVerifier: verifier,
			createdAt: now,
		};
		const state = await encodeState(c.env, statePayload);
		const baseUrl = getBaseUrl(c);
		const redirectUri = `${baseUrl}/api/v1/oauth/${body.provider}/callback`;

		if (body.provider === "gmail") {
			if (!c.env.OAUTH_GMAIL_CLIENT_ID) {
				return c.json({ error: "Gmail OAuth client is not configured" }, 500);
			}
			response = {
				connection,
				authUrl: buildGmailAuthUrl({
					clientId: c.env.OAUTH_GMAIL_CLIENT_ID,
					redirectUri,
					scopes: connection.scopes || DEFAULT_GMAIL_SCOPES,
					state,
					codeChallenge: challenge,
				}),
			};
		} else {
			if (!c.env.OAUTH_OUTLOOK_CLIENT_ID) {
				return c.json({ error: "Outlook OAuth client is not configured" }, 500);
			}
			response = {
				connection,
				authUrl: buildOutlookAuthUrl({
					tenant: c.env.OAUTH_OUTLOOK_TENANT || "common",
					clientId: c.env.OAUTH_OUTLOOK_CLIENT_ID,
					redirectUri,
					scopes: connection.scopes || DEFAULT_OUTLOOK_SCOPES,
					state,
					codeChallenge: challenge,
				}),
			};
		}
	} else if (body.provider === "imap") {
		if (!body.imap) {
			return c.json({ error: "IMAP credentials are required" }, 400);
		}
		const stub = c.var.mailboxStub as unknown as {
			setConnectionSecret: (id: string, provider: string, encrypted: string) => Promise<void>;
		};
		const secretPayload = {
			kind: "imap",
			host: body.imap.host,
			port: body.imap.port,
			username: body.imap.username,
			password: body.imap.password,
			useTLS: body.imap.useTLS ?? true,
		};
		const encrypted = await encryptJson(c.env, secretPayload);
		await stub.setConnectionSecret(connectionId, body.provider, encrypted);
	} else if (body.provider === "smtp" || body.provider === "lark") {
		const stub = c.var.mailboxStub as unknown as {
			setConnectionSecret: (id: string, provider: string, encrypted: string) => Promise<void>;
		};
		const ingestToken = crypto.randomUUID();
		const encrypted = await encryptJson(c.env, {
			kind: "smtp",
			token: ingestToken,
		});
		await stub.setConnectionSecret(connectionId, body.provider, encrypted);
		response = {
			connection,
			ingestUrl: `${getBaseUrl(c)}/api/v1/mailboxes/${mailboxId}/inbound/${connectionId}`,
			ingestToken,
		};
	}

	const updatedSettings = upsertConnection(settings, connection);
	await saveMailboxSettings(c.env.BUCKET, mailboxId, updatedSettings);
	return c.json(response, 201);
});

app.post("/api/v1/mailboxes/:mailboxId/connections/:connectionId/sync", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const connectionId = c.req.param("connectionId")!;
	const settings = await loadMailboxSettings(c.env.BUCKET, mailboxId);
	const connections = ensureConnections(settings);
	const connection = connections.find((conn) => conn.id === connectionId);
	if (!connection) return c.json({ error: "Connection not found" }, 404);
	const updated = await syncConnection(c.env, c.executionCtx, mailboxId, connection);
	const updatedSettings = {
		...settings,
		connections: connections.map((conn) => (conn.id === connectionId ? updated : conn)),
	};
	await saveMailboxSettings(c.env.BUCKET, mailboxId, updatedSettings);
	return c.json(updated);
});

app.delete("/api/v1/mailboxes/:mailboxId/connections/:connectionId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const connectionId = c.req.param("connectionId")!;
	const settings = await loadMailboxSettings(c.env.BUCKET, mailboxId);
	const updatedSettings = removeConnection(settings, connectionId);
	await saveMailboxSettings(c.env.BUCKET, mailboxId, updatedSettings);
	const stub = c.var.mailboxStub as unknown as {
		deleteConnectionSecret: (id: string) => Promise<void>;
	};
	await stub.deleteConnectionSecret(connectionId);
	return c.body(null, 204);
});

// -- OAuth callbacks ------------------------------------------------

app.get("/api/v1/oauth/:provider/callback", async (c) => {
	const provider = c.req.param("provider");
	const code = c.req.query("code");
	const state = c.req.query("state");
	if (!code || !state) return c.json({ error: "Missing OAuth code or state" }, 400);

	const payload = await decodeState<{
		mailboxId: string;
		connectionId: string;
		provider: string;
		codeVerifier: string;
		createdAt: string;
	}>(c.env, state);
	if (payload.provider !== provider) {
		return c.json({ error: "OAuth provider mismatch" }, 400);
	}

	const settings = await loadMailboxSettings(c.env.BUCKET, payload.mailboxId);
	const connections = ensureConnections(settings);
	const connection = connections.find((conn) => conn.id === payload.connectionId);
	if (!connection) return c.json({ error: "Connection not found" }, 404);

	const baseUrl = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
	const redirectUri = `${baseUrl}/api/v1/oauth/${provider}/callback`;

	let tokenResponse: {
		access_token: string;
		refresh_token?: string;
		expires_in?: number;
		scope?: string;
		token_type?: string;
	};
	if (provider === "gmail") {
		if (!c.env.OAUTH_GMAIL_CLIENT_ID || !c.env.OAUTH_GMAIL_CLIENT_SECRET) {
			return c.json({ error: "Gmail OAuth client is not configured" }, 500);
		}
		tokenResponse = await exchangeGmailCode({
			clientId: c.env.OAUTH_GMAIL_CLIENT_ID,
			clientSecret: c.env.OAUTH_GMAIL_CLIENT_SECRET,
			redirectUri,
			code,
			codeVerifier: payload.codeVerifier,
		});
	} else if (provider === "outlook") {
		if (!c.env.OAUTH_OUTLOOK_CLIENT_ID || !c.env.OAUTH_OUTLOOK_CLIENT_SECRET) {
			return c.json({ error: "Outlook OAuth client is not configured" }, 500);
		}
		tokenResponse = await exchangeOutlookCode({
			tenant: c.env.OAUTH_OUTLOOK_TENANT || "common",
			clientId: c.env.OAUTH_OUTLOOK_CLIENT_ID,
			clientSecret: c.env.OAUTH_OUTLOOK_CLIENT_SECRET,
			redirectUri,
			code,
			codeVerifier: payload.codeVerifier,
		});
	} else {
		return c.json({ error: "Unsupported OAuth provider" }, 400);
	}

	let profileOverrides: {
		email?: string;
		displayName?: string;
		externalAccountId?: string;
	} = {};

	try {
		if (provider === "gmail") {
			const profile = await getGmailProfile({
				accessToken: tokenResponse.access_token,
			});
			if (profile.emailAddress) {
				profileOverrides = {
					email: profile.emailAddress.toLowerCase(),
					externalAccountId: profile.emailAddress.toLowerCase(),
				};
			}
		} else if (provider === "outlook") {
			const profile = await getOutlookProfile({
				accessToken: tokenResponse.access_token,
			});
			const email =
				profile.mail || profile.userPrincipalName || connection.email;
			profileOverrides = {
				email: email?.toLowerCase(),
				displayName: profile.displayName || connection.displayName,
				externalAccountId: profile.id,
			};
		}
	} catch (error) {
		console.warn(
			`OAuth profile fetch failed for ${provider}:`,
			(error as Error).message,
		);
	}

	const stub = c.env.MAILBOX.get(
		c.env.MAILBOX.idFromName(payload.mailboxId),
	) as unknown as {
		setConnectionSecret: (id: string, provider: string, encrypted: string) => Promise<void>;
	};
	const encrypted = await encryptJson(c.env, {
		kind: "oauth",
		accessToken: tokenResponse.access_token,
		refreshToken: tokenResponse.refresh_token,
		expiresAt: tokenResponse.expires_in
			? new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
			: undefined,
		scope: tokenResponse.scope,
		tokenType: tokenResponse.token_type,
	});
	await stub.setConnectionSecret(payload.connectionId, provider, encrypted);

	const updatedConnection = {
		...connection,
		...(profileOverrides.email ? { email: profileOverrides.email } : {}),
		...(profileOverrides.displayName
			? { displayName: profileOverrides.displayName }
			: {}),
		...(profileOverrides.externalAccountId
			? { externalAccountId: profileOverrides.externalAccountId }
			: {}),
		status: "connected",
		lastError: null,
		updatedAt: new Date().toISOString(),
	};
	const updatedSettings = {
		...settings,
		connections: connections.map((conn) =>
			conn.id === connection.id ? updatedConnection : conn,
		),
	};
	await saveMailboxSettings(c.env.BUCKET, payload.mailboxId, updatedSettings);

	const redirectTo = `${baseUrl}/mailbox/${payload.mailboxId}/settings?connected=${provider}`;
	return c.redirect(redirectTo);
});

// -- Inbound SMTP/IMAP HTTP ingestion -------------------------------

app.post("/api/v1/mailboxes/:mailboxId/inbound/:connectionId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const connectionId = c.req.param("connectionId")!;
	const authHeader = c.req.header("authorization") || "";
	const bearerToken = authHeader.startsWith("Bearer ")
		? authHeader.slice("Bearer ".length).trim()
		: undefined;
	const token = bearerToken || c.req.query("token") || "";
	if (!token) return c.json({ error: "Missing inbound token" }, 401);

	const stub = c.var.mailboxStub as unknown as {
		getConnectionSecret: (id: string) => Promise<{ encrypted: string } | null>;
	};
	const secretRow = await stub.getConnectionSecret(connectionId);
	let authorized = false;
	if (secretRow) {
		const secret = await decryptJson<{ kind: string; token?: string }>(
			c.env,
			secretRow.encrypted,
		);
		if (secret.kind === "smtp" && secret.token === token) {
			authorized = true;
		}
	}
	if (!authorized && c.env.INBOUND_SHARED_SECRET) {
		authorized = token === c.env.INBOUND_SHARED_SECRET;
	}
	if (!authorized) return c.json({ error: "Invalid inbound token" }, 403);

	let raw: Uint8Array;
	let sourceOverrides: Record<string, unknown> | undefined;
	const contentType = c.req.header("content-type") || "";
	if (contentType.includes("application/json")) {
		const body = (await c.req.json()) as { raw: string; source?: Record<string, unknown> };
		if (!body.raw) return c.json({ error: "Missing raw payload" }, 400);
		const binary = atob(body.raw);
		raw = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) raw[i] = binary.charCodeAt(i);
		sourceOverrides = body.source;
	} else {
		raw = await bufferFromRequest(c.req.raw);
	}

	const settings = await loadMailboxSettings(c.env.BUCKET, mailboxId);
	const connections = ensureConnections(settings);
	const connection = connections.find((conn) => conn.id === connectionId);
	if (!connection) return c.json({ error: "Connection not found" }, 404);
	const provider = connection.provider;

	const result = await ingestRawEmail({
		env: c.env,
		ctx: c.executionCtx,
		mailboxId,
		raw,
		source: {
			provider: (sourceOverrides?.provider as ConnectionProvider) || provider,
			messageId: sourceOverrides?.messageId as string | undefined,
			threadId: sourceOverrides?.threadId as string | undefined,
			folderId: sourceOverrides?.folderId as string | undefined,
			accountId: connection?.externalAccountId || connection?.email,
		},
	});

	return c.json(result, 202);
});

// -- Emails ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const folder = c.req.query("folder");
	const thread_id = c.req.query("thread_id");
	const threaded = boolQuery(c, "threaded");
	const page = intQuery(c, "page");
	const limit = intQuery(c, "limit");
	const sortColumn = c.req.query("sortColumn") as any;
	const sortDirection = c.req.query("sortDirection") as "ASC" | "DESC" | undefined;
	const stub = c.var.mailboxStub;

	if (threaded && folder) {
		const emails = await (stub as any).getThreadedEmails({ folder, page, limit });
		const totalCount = await (stub as any).countThreadedEmails(folder);
		return c.json({ emails, totalCount });
	}
	const emails = await stub.getEmails({ folder, thread_id, page, limit, sortColumn, sortDirection });
	if (folder) {
		const totalCount = await stub.countEmails({ folder, thread_id });
		return c.json({ emails, totalCount });
	}
	return c.json(emails);
});

app.post("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments, in_reply_to, references, thread_id } = body;

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	const stub = c.var.mailboxStub;
	const rateLimitError = await (stub as any).checkSendRateLimit();
	if (rateLimitError) return c.json({ error: rateLimitError }, 429);
	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	await stub.createEmail(Folders.SENT, {
		id: messageId, subject, sender: fromEmail, recipient: toStr,
		cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
		bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
		date: new Date().toISOString(), body: html || text || "",
		in_reply_to: in_reply_to || null, email_references: references ? JSON.stringify(references) : null,
		thread_id: thread_id || in_reply_to || messageId, message_id: outgoingMessageId,
		raw_headers: JSON.stringify([
			{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
			{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
			...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
			...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
			{ key: "subject", value: subject }, { key: "date", value: new Date().toISOString() },
			{ key: "message-id", value: `<${outgoingMessageId}>` },
		]),
	}, attachmentData);

	c.executionCtx.waitUntil(
		sendOutgoingEmail({
			env: c.env,
			mailboxId,
			message: {
				to,
				cc,
				bcc,
				from,
				subject,
				html,
				text,
				attachments: attachments?.map((att) => ({
					content: att.content,
					filename: att.filename,
					type: att.type,
					disposition: att.disposition || "attachment",
					contentId: att.contentId,
				})),
				...(in_reply_to
					? { headers: buildThreadingHeaders(in_reply_to, references || []) }
					: {}),
			},
		}).catch((e) =>
			console.error("Deferred email delivery failed:", (e as Error).message),
		),
	);
	return c.json({ id: messageId, status: "sent" }, 202);
});

app.post("/api/v1/mailboxes/:mailboxId/drafts", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { to, cc, bcc, subject, body, in_reply_to, thread_id, draft_id } = DraftBody.parse(await c.req.json());
	const stub = c.var.mailboxStub;
	if (draft_id) await stub.deleteEmail(draft_id); // not atomic — create-then-delete would be safer
	const messageId = crypto.randomUUID();
	const now = new Date().toISOString();
	await stub.createEmail(Folders.DRAFT, {
		id: messageId, subject: subject || "", sender: mailboxId.toLowerCase(),
		recipient: (to || "").toLowerCase(), cc: cc?.toLowerCase() || null, bcc: bcc?.toLowerCase() || null,
		date: now, body, in_reply_to: in_reply_to || null, email_references: null,
		thread_id: thread_id || in_reply_to || messageId,
	}, []);
	return c.json({ id: messageId, status: "draft", subject: subject || "", recipient: to || "", date: now }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const email = await c.var.mailboxStub.getEmail(c.req.param("id")!);
	if (!email) return c.json({ error: "Email not found" }, 404);
	return new Response(JSON.stringify(email), {
		headers: { "Content-Type": "application/json" },
	});
});

app.put("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const { read, starred } = (await c.req.json()) as { read?: boolean; starred?: boolean };
	const email = await c.var.mailboxStub.updateEmail(c.req.param("id")!, { read, starred });
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const id = c.req.param("id")!;
	const attachments = await c.var.mailboxStub.deleteEmail(id);
	if (attachments === null) return c.json({ error: "Not found" }, 404);
	if (attachments.length > 0) await c.env.BUCKET.delete(attachments.map((att: any) => `attachments/${id}/${att.id}/${att.filename}`));
	return c.body(null, 204);
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", async (c: AppContext) => {
	const { folderId } = (await c.req.json()) as { folderId: string };
	const success = await c.var.mailboxStub.moveEmail(c.req.param("id")!, folderId);
	return success ? c.json({ status: "moved" }) : c.json({ error: "Folder not found" }, 400);
});

// -- Threads --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/threads/:threadId", async (c: AppContext) => {
	return c.json(await (c.var.mailboxStub as any).getThreadEmails(c.req.param("threadId")!));
});

app.post("/api/v1/mailboxes/:mailboxId/threads/:threadId/read", async (c: AppContext) => {
	await c.var.mailboxStub.markThreadRead(c.req.param("threadId")!);
	return c.json({ status: "marked_read" });
});

// -- Reply / Forward ------------------------------------------------

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/reply", handleReplyEmail);
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/forward", handleForwardEmail);

// -- Folders --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => c.json(await c.var.mailboxStub.getFolders()));

app.post("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const slug = slugify(name);
	if (!slug) return c.json({ error: "Folder name must contain alphanumeric characters" }, 400);
	const f = await c.var.mailboxStub.createFolder(slug, name);
	return f ? c.json(f, 201) : c.json({ error: "Folder with this name already exists" }, 409);
});

app.put("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const f = await c.var.mailboxStub.updateFolder(c.req.param("id")!, name);
	return f ? c.json(f) : c.json({ error: "Folder not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const ok = await c.var.mailboxStub.deleteFolder(c.req.param("id")!);
	return ok ? c.body(null, 204) : c.json({ error: "Folder not found or cannot be deleted" }, 400);
});

// -- Search ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/search", async (c: AppContext) => {
	const searchOpts: Record<string, unknown> = {
		query: c.req.query("query") || "", folder: c.req.query("folder"), from: c.req.query("from"),
		to: c.req.query("to"), subject: c.req.query("subject"), date_start: c.req.query("date_start"),
		date_end: c.req.query("date_end"), is_read: boolQuery(c, "is_read"),
		is_starred: boolQuery(c, "is_starred"), has_attachment: boolQuery(c, "has_attachment"),
	};
	const stub = c.var.mailboxStub as any;
	const emails = await stub.searchEmails({ ...searchOpts, page: intQuery(c, "page"), limit: intQuery(c, "limit") });
	const totalCount = await stub.countSearchResults(searchOpts);
	return c.json({ emails, totalCount });
});

// -- Attachments ----------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId", async (c: AppContext) => {
	const emailId = c.req.param("emailId")!;
	const attachmentId = c.req.param("attachmentId")!;
	const attachment = await c.var.mailboxStub.getAttachment(attachmentId);
	if (!attachment) return c.json({ error: "Attachment not found" }, 404);
	const obj = await c.env.BUCKET.get(`attachments/${emailId}/${attachmentId}/${attachment.filename}`);
	if (!obj) return c.json({ error: "Attachment file not found" }, 404);
	const headers = new Headers();
	headers.set("Content-Type", attachment.mimetype);
	const sanitized = attachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
	headers.set("Content-Disposition", `attachment; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
	return new Response(obj.body, { headers });
});

// -- Receive inbound email ------------------------------------------

async function receiveEmail(
	event: { raw: ReadableStream; rawSize: number },
	env: Env,
	ctx: ExecutionContext,
) {
	const rawEmail = await streamToArrayBuffer(event.raw, event.rawSize);
	const parsedEmail = await new PostalMime().parse(rawEmail);

	if (!parsedEmail.to?.length || !parsedEmail.to[0].address) {
		throw new Error("received email with empty to");
	}

	const allowedAddresses = ((env.EMAIL_ADDRESSES ?? []) as string[]).map((a) =>
		a.toLowerCase(),
	);
	const allRecipients = parsedEmail.to
		.map((t) => t.address?.toLowerCase())
		.filter(Boolean) as string[];

	let mailboxId: string | undefined;
	if (allowedAddresses.length > 0) {
		mailboxId = allRecipients.find((addr) => allowedAddresses.includes(addr));
		if (!mailboxId) {
			console.log("Ignoring email: no recipient matches EMAIL_ADDRESSES.");
			return;
		}
	} else {
		mailboxId = allRecipients[0];
	}
	if (!mailboxId) {
		throw new Error("received email with no valid recipient address");
	}

	if (!(await env.BUCKET.head(`mailboxes/${mailboxId}.json`))) {
		console.log(`Ignoring email for ${mailboxId}: mailbox does not exist`);
		return;
	}

	const sourceMessageId = parsedEmail.messageId
		? parsedEmail.messageId.replace(/[<>]/g, "")
		: undefined;

	await ingestRawEmail({
		env,
		ctx,
		mailboxId,
		raw: rawEmail,
		source: {
			provider: "routing",
			messageId: sourceMessageId,
			accountId: mailboxId,
		},
	});
}

export { app, receiveEmail };
