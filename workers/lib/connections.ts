// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export type ConnectionProvider = "gmail" | "outlook" | "imap" | "smtp";
export type ConnectionStatus = "pending" | "connected" | "error";
export type SendMode = "cloudflare" | "provider";

export interface MailboxConnection {
	id: string;
	provider: ConnectionProvider;
	email: string;
	displayName?: string;
	status: ConnectionStatus;
	sendMode: SendMode;
	folderMap?: Record<string, string>;
	scopes?: string[];
	externalAccountId?: string;
	lastSync?: string;
	lastError?: string | null;
	createdAt?: string;
	updatedAt?: string;
}

export type OAuthSecret = {
	kind: "oauth";
	accessToken: string;
	refreshToken?: string;
	expiresAt?: string;
	scope?: string;
	tokenType?: string;
	sync?: {
		cursor?: string;
		deltaLink?: string;
		lastSync?: string;
	};
};

export type ImapSecret = {
	kind: "imap";
	host: string;
	port: number;
	username: string;
	password: string;
	useTLS: boolean;
	sync?: {
		lastUid?: number;
		lastSync?: string;
	};
};

export type SmtpInboundSecret = {
	kind: "smtp";
	token: string;
};

export type ConnectionSecret = OAuthSecret | ImapSecret | SmtpInboundSecret;

export async function loadMailboxSettings(
	bucket: R2Bucket,
	mailboxId: string,
): Promise<Record<string, unknown>> {
	const obj = await bucket.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return {};
	return obj.json<Record<string, unknown>>();
}

export async function saveMailboxSettings(
	bucket: R2Bucket,
	mailboxId: string,
	settings: Record<string, unknown>,
) {
	await bucket.put(`mailboxes/${mailboxId}.json`, JSON.stringify(settings));
}

export function ensureConnections(settings?: Record<string, unknown>): MailboxConnection[] {
	const raw = settings?.connections;
	if (Array.isArray(raw)) {
		return raw.filter(Boolean) as MailboxConnection[];
	}
	return [];
}

export function upsertConnection(
	settings: Record<string, unknown> | undefined,
	connection: MailboxConnection,
) {
	const next = { ...(settings ?? {}) } as Record<string, unknown>;
	const connections = ensureConnections(next);
	const idx = connections.findIndex((c) => c.id === connection.id);
	if (idx >= 0) {
		connections[idx] = connection;
	} else {
		connections.push(connection);
	}
	next.connections = connections;
	return next;
}

export function removeConnection(
	settings: Record<string, unknown> | undefined,
	connectionId: string,
) {
	const next = { ...(settings ?? {}) } as Record<string, unknown>;
	const connections = ensureConnections(next).filter(
		(c) => c.id !== connectionId,
	);
	next.connections = connections;
	return next;
}

export function generateConnectionId(provider: ConnectionProvider) {
	return `${provider}_${crypto.randomUUID()}`;
}
