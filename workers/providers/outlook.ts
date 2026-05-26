// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export const DEFAULT_OUTLOOK_SCOPES = [
	"offline_access",
	"Mail.ReadWrite",
	"Mail.Send",
];

type TokenResponse = {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
	token_type?: string;
};

function toForm(body: Record<string, string>) {
	return new URLSearchParams(body).toString();
}

function withBearer(token: string) {
	return { Authorization: "Bearer " + token };
}

function tenantAuthUrl(tenant: string) {
	return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
}

function tenantTokenUrl(tenant: string) {
	return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

export function buildOutlookAuthUrl(opts: {
	tenant: string;
	clientId: string;
	redirectUri: string;
	scopes: string[];
	state: string;
	codeChallenge: string;
}): string {
	const url = new URL(tenantAuthUrl(opts.tenant));
	url.searchParams.set("client_id", opts.clientId);
	url.searchParams.set("redirect_uri", opts.redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", opts.scopes.join(" "));
	url.searchParams.set("state", opts.state);
	url.searchParams.set("code_challenge", opts.codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	return url.toString();
}

export async function exchangeOutlookCode(opts: {
	tenant: string;
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	code: string;
	codeVerifier: string;
}): Promise<TokenResponse> {
	const res = await fetch(tenantTokenUrl(opts.tenant), {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: toForm({
			client_id: opts.clientId,
			client_secret: opts.clientSecret,
			redirect_uri: opts.redirectUri,
			grant_type: "authorization_code",
			code: opts.code,
			code_verifier: opts.codeVerifier,
		}),
	});
	if (!res.ok) {
		throw new Error(`Outlook token exchange failed: ${await res.text()}`);
	}
	return (await res.json()) as TokenResponse;
}

export async function refreshOutlookToken(opts: {
	tenant: string;
	clientId: string;
	clientSecret: string;
	refreshToken: string;
}): Promise<TokenResponse> {
	const res = await fetch(tenantTokenUrl(opts.tenant), {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: toForm({
			client_id: opts.clientId,
			client_secret: opts.clientSecret,
			grant_type: "refresh_token",
			refresh_token: opts.refreshToken,
		}),
	});
	if (!res.ok) {
		throw new Error(`Outlook token refresh failed: ${await res.text()}`);
	}
	return (await res.json()) as TokenResponse;
}

export async function listOutlookMessages(opts: {
	accessToken: string;
	folderId?: string;
	since?: string;
	top?: number;
}) {
	const folder = opts.folderId ?? "inbox";
	const url = new URL(`${GRAPH_BASE}/me/mailFolders/${folder}/messages`);
	url.searchParams.set("$select", "id,receivedDateTime,internetMessageId,parentFolderId,conversationId");
	url.searchParams.set("$orderby", "receivedDateTime desc");
	url.searchParams.set("$top", `${opts.top ?? 25}`);
	if (opts.since) {
		url.searchParams.set("$filter", `receivedDateTime ge '${opts.since}'`);
	}
	const res = await fetch(url, { headers: withBearer(opts.accessToken) });
	if (!res.ok) {
		throw new Error(`Outlook list messages failed: ${await res.text()}`);
	}
	return res.json() as Promise<{ value: { id: string; parentFolderId?: string; internetMessageId?: string; conversationId?: string }[] }>;
}

export async function getOutlookMessageRaw(opts: {
	accessToken: string;
	messageId: string;
}) {
	const res = await fetch(
		`${GRAPH_BASE}/me/messages/${opts.messageId}/$value`,
		{
			headers: { ...withBearer(opts.accessToken), Accept: "message/rfc822" },
		},
	);
	if (!res.ok) {
		throw new Error(`Outlook get message failed: ${await res.text()}`);
	}
	return res.arrayBuffer();
}

export async function sendOutlookMessage(opts: {
	accessToken: string;
	subject: string;
	from?: string;
	to: string | string[];
	cc?: string | string[];
	bcc?: string | string[];
	html?: string;
	text?: string;
	attachments?: {
		content: string;
		filename: string;
		type: string;
		disposition: "attachment" | "inline";
	}[];
	headers?: Record<string, string>;
}) {
	const toRecipients = (Array.isArray(opts.to) ? opts.to : [opts.to]).map(
		(address) => ({ emailAddress: { address } }),
	);
	const ccRecipients = (opts.cc
		? Array.isArray(opts.cc)
			? opts.cc
			: [opts.cc]
		: []
	).map((address) => ({ emailAddress: { address } }));
	const bccRecipients = (opts.bcc
		? Array.isArray(opts.bcc)
			? opts.bcc
			: [opts.bcc]
		: []
	).map((address) => ({ emailAddress: { address } }));

	const attachments = (opts.attachments ?? []).map((att) => ({
		"@odata.type": "#microsoft.graph.fileAttachment",
		name: att.filename,
		contentType: att.type,
		contentBytes: att.content,
		isInline: att.disposition === "inline",
	}));

	const body = opts.html ?? opts.text ?? "";
	const contentType = opts.html ? "HTML" : "Text";

	const res = await fetch(`${GRAPH_BASE}/me/sendMail`, {
		method: "POST",
		headers: {
			...withBearer(opts.accessToken),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			message: {
				subject: opts.subject,
				body: { contentType, content: body },
				toRecipients,
				ccRecipients: ccRecipients.length > 0 ? ccRecipients : undefined,
				bccRecipients: bccRecipients.length > 0 ? bccRecipients : undefined,
				attachments: attachments.length > 0 ? attachments : undefined,
				internetMessageHeaders: opts.headers
					? Object.entries(opts.headers).map(([name, value]) => ({
							name,
							value,
						}))
					: undefined,
			},
			saveToSentItems: true,
		}),
	});

	if (!res.ok) {
		throw new Error(`Outlook send failed: ${await res.text()}`);
	}
}
