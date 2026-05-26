// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Env } from "../types";
import { sendEmail } from "../email-sender";
import { buildMimeMessage } from "./mime";
import {
	DEFAULT_GMAIL_SCOPES,
	refreshGmailToken,
	sendGmailRawMessage,
} from "../providers/gmail";
import {
	DEFAULT_OUTLOOK_SCOPES,
	refreshOutlookToken,
	sendOutlookMessage,
} from "../providers/outlook";
import {
	ConnectionSecret,
	MailboxConnection,
	ensureConnections,
	loadMailboxSettings,
} from "./connections";
import { decryptJson, encryptJson } from "./crypto";
import { getMailboxStub } from "./email-helpers";

type ConnectionSecretRow = {
	provider: string;
	encrypted: string;
};

export type OutgoingSendResult = { provider: "cloudflare" | "gmail" | "outlook" };

function isExpired(expiresAt?: string) {
	if (!expiresAt) return false;
	return Date.now() > Date.parse(expiresAt) - 5 * 60 * 1000;
}

function resolveSendConnection(connections: MailboxConnection[]) {
	return connections.find(
		(conn) => conn.sendMode === "provider" && conn.status === "connected",
	);
}

async function getSecret(
	env: Env,
	mailboxId: string,
	connectionId: string,
): Promise<ConnectionSecret | null> {
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

export async function sendOutgoingEmail(params: {
	env: Env;
	mailboxId: string;
	message: {
		to: string | string[];
		cc?: string | string[];
		bcc?: string | string[];
		from: string | { email: string; name: string };
		subject: string;
		html?: string;
		text?: string;
		attachments?: {
			content: string;
			filename: string;
			type: string;
			disposition: "attachment" | "inline";
			contentId?: string;
		}[];
		headers?: Record<string, string>;
	};
}): Promise<OutgoingSendResult> {
	const { env, mailboxId, message } = params;
	const settings = await loadMailboxSettings(env.BUCKET, mailboxId);
	const connections = ensureConnections(settings);
	const sendConn = resolveSendConnection(connections);

	if (!sendConn) {
		await sendEmail(env.EMAIL, message);
		return { provider: "cloudflare" };
	}

	if (sendConn.provider === "gmail") {
		if (!env.OAUTH_GMAIL_CLIENT_ID || !env.OAUTH_GMAIL_CLIENT_SECRET) {
			throw new Error("Gmail OAuth client is not configured");
		}
		const secret = await getSecret(env, mailboxId, sendConn.id);
		if (!secret || secret.kind !== "oauth") {
			await sendEmail(env.EMAIL, message);
			return { provider: "cloudflare" };
		}
		let accessToken = secret.accessToken;
		if (isExpired(secret.expiresAt) && secret.refreshToken) {
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
			await setSecret(env, mailboxId, sendConn.id, sendConn.provider, secret);
		}

		const rawMessage = buildMimeMessage({
			from: message.from,
			to: message.to,
			cc: message.cc,
			bcc: message.bcc,
			subject: message.subject,
			html: message.html,
			text: message.text,
			headers: message.headers,
			attachments: message.attachments,
		});
		await sendGmailRawMessage({ accessToken, rawMessage });
		return { provider: "gmail" };
	}

	if (sendConn.provider === "outlook") {
		if (!env.OAUTH_OUTLOOK_CLIENT_ID || !env.OAUTH_OUTLOOK_CLIENT_SECRET) {
			throw new Error("Outlook OAuth client is not configured");
		}
		const secret = await getSecret(env, mailboxId, sendConn.id);
		if (!secret || secret.kind !== "oauth") {
			await sendEmail(env.EMAIL, message);
			return { provider: "cloudflare" };
		}
		let accessToken = secret.accessToken;
		if (isExpired(secret.expiresAt) && secret.refreshToken) {
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
			await setSecret(env, mailboxId, sendConn.id, sendConn.provider, secret);
		}

		await sendOutlookMessage({
			accessToken,
			subject: message.subject,
			to: message.to,
			cc: message.cc,
			bcc: message.bcc,
			html: message.html,
			text: message.text,
			attachments: message.attachments?.map((att) => ({
				content: att.content,
				filename: att.filename,
				type: att.type,
				disposition: att.disposition,
			})),
			headers: message.headers,
		});
		return { provider: "outlook" };
	}

	await sendEmail(env.EMAIL, message);
	return { provider: "cloudflare" };
}
