// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Env } from "./types";
import {
	ConnectionSecret,
	MailboxConnection,
	ensureConnections,
	loadMailboxSettings,
	saveMailboxSettings,
} from "./lib/connections";
import { decryptJson, encryptJson } from "./lib/crypto";
import { ingestRawEmail } from "./lib/ingest";
import { getMailboxStub, listMailboxes } from "./lib/email-helpers";
import {
	DEFAULT_GMAIL_SCOPES,
	getGmailMessageRaw,
	listGmailMessages,
	refreshGmailToken,
} from "./providers/gmail";
import {
	DEFAULT_OUTLOOK_SCOPES,
	getOutlookMessageRaw,
	listOutlookMessages,
	refreshOutlookToken,
} from "./providers/outlook";
import { base64UrlDecode } from "./lib/oauth";
import { Folders } from "../shared/folders";

const SYNC_BATCH_SIZE = 25;
const SYNC_SAFETY_SECONDS = 120;

type ConnectionSecretRow = { provider: string; encrypted: string };

function safeDate(date?: string) {
	if (!date) return null;
	const d = new Date(date);
	return Number.isNaN(d.getTime()) ? null : d;
}

function withSafetyWindow(date?: Date | null) {
	if (!date) return null;
	return new Date(date.getTime() - SYNC_SAFETY_SECONDS * 1000);
}

async function getSecret(env: Env, mailboxId: string, connectionId: string) {
	const stub = getMailboxStub(env, mailboxId) as unknown as {
		getConnectionSecret: (id: string) => Promise<ConnectionSecretRow | null>;
	};
	const row = await stub.getConnectionSecret(connectionId);
	if (!row) return null;
	return decryptJson<ConnectionSecret>(env, row.encrypted);
}

async function setSecret(
	env: Env,
	mailboxId: string,
	connectionId: string,
	provider: string,
	secret: ConnectionSecret,
) {
	const stub = getMailboxStub(env, mailboxId) as unknown as {
		setConnectionSecret: (id: string, provider: string, encrypted: string) => Promise<void>;
	};
	const encrypted = await encryptJson(env, secret);
	await stub.setConnectionSecret(connectionId, provider, encrypted);
}

function updateConnection(
	connection: MailboxConnection,
	updates: Partial<MailboxConnection>,
): MailboxConnection {
	return {
		...connection,
		...updates,
		updatedAt: new Date().toISOString(),
	};
}

async function syncGmail(
	env: Env,
	ctx: ExecutionContext,
	mailboxId: string,
	connection: MailboxConnection,
) {
	if (!env.OAUTH_GMAIL_CLIENT_ID || !env.OAUTH_GMAIL_CLIENT_SECRET) {
		throw new Error("Gmail OAuth client is not configured");
	}
	const secret = await getSecret(env, mailboxId, connection.id);
	if (!secret || secret.kind !== "oauth") {
		throw new Error("Missing Gmail OAuth secret");
	}
	let accessToken = secret.accessToken;
	if (secret.expiresAt && new Date(secret.expiresAt).getTime() < Date.now()) {
		if (!secret.refreshToken) {
			throw new Error("Gmail refresh token missing");
		}
		const refresh = await refreshGmailToken({
			clientId: env.OAUTH_GMAIL_CLIENT_ID,
			clientSecret: env.OAUTH_GMAIL_CLIENT_SECRET,
			refreshToken: secret.refreshToken,
		});
		accessToken = refresh.access_token;
		secret.accessToken = refresh.access_token;
		secret.expiresAt = refresh.expires_in
			? new Date(Date.now() + refresh.expires_in * 1000).toISOString()
			: undefined;
		secret.scope = refresh.scope ?? secret.scope ?? DEFAULT_GMAIL_SCOPES.join(" ");
	}

	const lastSync = withSafetyWindow(
		safeDate(secret.sync?.lastSync ?? connection.lastSync),
	);
	const query = lastSync
		? `after:${Math.floor(lastSync.getTime() / 1000)}`
		: undefined;

	const list = await listGmailMessages({
		accessToken,
		query,
		maxResults: SYNC_BATCH_SIZE,
	});
	const messages = list.messages ?? [];
	for (const msg of messages) {
		const raw = await getGmailMessageRaw({
			accessToken,
			messageId: msg.id,
		});
		const rawBytes = base64UrlDecode(raw);
		await ingestRawEmail({
			env,
			ctx,
			mailboxId,
			raw: rawBytes,
			source: {
				provider: "gmail",
				messageId: msg.id,
				threadId: msg.threadId,
				accountId: connection.externalAccountId || connection.email,
				folderId: connection.folderMap?.inbox || Folders.INBOX,
			},
		});
	}

	secret.sync = {
		...secret.sync,
		lastSync: new Date().toISOString(),
	};
	await setSecret(env, mailboxId, connection.id, connection.provider, secret);
	return updateConnection(connection, { lastSync: secret.sync.lastSync, status: "connected", lastError: null });
}

async function syncOutlook(
	env: Env,
	ctx: ExecutionContext,
	mailboxId: string,
	connection: MailboxConnection,
) {
	if (!env.OAUTH_OUTLOOK_CLIENT_ID || !env.OAUTH_OUTLOOK_CLIENT_SECRET) {
		throw new Error("Outlook OAuth client is not configured");
	}
	const secret = await getSecret(env, mailboxId, connection.id);
	if (!secret || secret.kind !== "oauth") {
		throw new Error("Missing Outlook OAuth secret");
	}
	let accessToken = secret.accessToken;
	if (secret.expiresAt && new Date(secret.expiresAt).getTime() < Date.now()) {
		if (!secret.refreshToken) {
			throw new Error("Outlook refresh token missing");
		}
		const refresh = await refreshOutlookToken({
			tenant: env.OAUTH_OUTLOOK_TENANT || "common",
			clientId: env.OAUTH_OUTLOOK_CLIENT_ID,
			clientSecret: env.OAUTH_OUTLOOK_CLIENT_SECRET,
			refreshToken: secret.refreshToken,
		});
		accessToken = refresh.access_token;
		secret.accessToken = refresh.access_token;
		secret.expiresAt = refresh.expires_in
			? new Date(Date.now() + refresh.expires_in * 1000).toISOString()
			: undefined;
		secret.scope = refresh.scope ?? secret.scope ?? DEFAULT_OUTLOOK_SCOPES.join(" ");
	}

	const lastSync = withSafetyWindow(
		safeDate(secret.sync?.lastSync ?? connection.lastSync),
	);
	const list = await listOutlookMessages({
		accessToken,
		since: lastSync ? lastSync.toISOString() : undefined,
		top: SYNC_BATCH_SIZE,
	});

	for (const msg of list.value || []) {
		const raw = await getOutlookMessageRaw({
			accessToken,
			messageId: msg.id,
		});
		await ingestRawEmail({
			env,
			ctx,
			mailboxId,
			raw: new Uint8Array(raw),
			source: {
				provider: "outlook",
				messageId: msg.id,
				threadId: msg.conversationId,
				accountId: connection.externalAccountId || connection.email,
				folderId:
					(connection.folderMap && msg.parentFolderId
						? connection.folderMap[msg.parentFolderId]
						: undefined) || Folders.INBOX,
			},
		});
	}

	secret.sync = {
		...secret.sync,
		lastSync: new Date().toISOString(),
	};
	await setSecret(env, mailboxId, connection.id, connection.provider, secret);
	return updateConnection(connection, { lastSync: secret.sync.lastSync, status: "connected", lastError: null });
}

export async function syncConnection(
	env: Env,
	ctx: ExecutionContext,
	mailboxId: string,
	connection: MailboxConnection,
) {
	try {
		if (connection.provider === "gmail") {
			return await syncGmail(env, ctx, mailboxId, connection);
		}
		if (connection.provider === "outlook") {
			return await syncOutlook(env, ctx, mailboxId, connection);
		}
		return updateConnection(connection, {
			status: "connected",
			lastError: null,
		});
	} catch (error) {
		return updateConnection(connection, {
			status: "error",
			lastError: (error as Error).message,
		});
	}
}

export async function syncMailboxConnections(
	env: Env,
	ctx: ExecutionContext,
	mailboxId: string,
) {
	const settings = await loadMailboxSettings(env.BUCKET, mailboxId);
	const connections = ensureConnections(settings);
	const updated: MailboxConnection[] = [];
	for (const connection of connections) {
		if (connection.status === "pending") {
			updated.push(connection);
			continue;
		}
		if (connection.provider === "gmail" || connection.provider === "outlook") {
			updated.push(await syncConnection(env, ctx, mailboxId, connection));
			continue;
		}
		updated.push(connection);
	}
	await saveMailboxSettings(env.BUCKET, mailboxId, {
		...settings,
		connections: updated,
	});
	return updated;
}

export async function runSyncCron(env: Env, ctx: ExecutionContext) {
	const mailboxes = await listMailboxes(env.BUCKET);
	for (const mailbox of mailboxes) {
		ctx.waitUntil(syncMailboxConnections(env, ctx, mailbox.id));
	}
}
