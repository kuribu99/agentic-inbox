// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { base64UrlEncode } from "../lib/oauth";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://gmail.googleapis.com/gmail/v1";

export const DEFAULT_GMAIL_SCOPES = [
	"https://www.googleapis.com/auth/gmail.modify",
	"https://www.googleapis.com/auth/gmail.send",
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

export function buildGmailAuthUrl(opts: {
	clientId: string;
	redirectUri: string;
	scopes: string[];
	state: string;
	codeChallenge: string;
}): string {
	const url = new URL(AUTH_URL);
	url.searchParams.set("client_id", opts.clientId);
	url.searchParams.set("redirect_uri", opts.redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", opts.scopes.join(" "));
	url.searchParams.set("access_type", "offline");
	url.searchParams.set("prompt", "consent");
	url.searchParams.set("state", opts.state);
	url.searchParams.set("code_challenge", opts.codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	return url.toString();
}

export async function exchangeGmailCode(opts: {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	code: string;
	codeVerifier: string;
}): Promise<TokenResponse> {
	const res = await fetch(TOKEN_URL, {
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
		throw new Error(`Gmail token exchange failed: ${await res.text()}`);
	}
	return (await res.json()) as TokenResponse;
}

export async function refreshGmailToken(opts: {
	clientId: string;
	clientSecret: string;
	refreshToken: string;
}): Promise<TokenResponse> {
	const res = await fetch(TOKEN_URL, {
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
		throw new Error(`Gmail token refresh failed: ${await res.text()}`);
	}
	return (await res.json()) as TokenResponse;
}

export async function getGmailProfile(opts: { accessToken: string }) {
	const res = await fetch(`${API_BASE}/users/me/profile`, {
		headers: withBearer(opts.accessToken),
	});
	if (!res.ok) {
		throw new Error(`Gmail profile fetch failed: ${await res.text()}`);
	}
	return res.json() as Promise<{
		emailAddress: string;
		historyId?: string;
		messagesTotal?: number;
		threadsTotal?: number;
	}>;
}

export async function listGmailMessages(opts: {
	accessToken: string;
	query?: string;
	labelIds?: string[];
	pageToken?: string;
	maxResults?: number;
}) {
	const url = new URL(`${API_BASE}/users/me/messages`);
	if (opts.query) url.searchParams.set("q", opts.query);
	if (opts.pageToken) url.searchParams.set("pageToken", opts.pageToken);
	if (opts.maxResults) url.searchParams.set("maxResults", `${opts.maxResults}`);
	if (opts.labelIds) {
		for (const label of opts.labelIds) url.searchParams.append("labelIds", label);
	}
	const res = await fetch(url, { headers: withBearer(opts.accessToken) });
	if (!res.ok) {
		throw new Error(`Gmail list messages failed: ${await res.text()}`);
	}
	return res.json() as Promise<{
		messages?: { id: string; threadId?: string }[];
		nextPageToken?: string;
	}>;
}

export async function getGmailMessageRaw(opts: {
	accessToken: string;
	messageId: string;
}) {
	const url = new URL(`${API_BASE}/users/me/messages/${opts.messageId}`);
	url.searchParams.set("format", "raw");
	const res = await fetch(url, { headers: withBearer(opts.accessToken) });
	if (!res.ok) {
		throw new Error(`Gmail get message failed: ${await res.text()}`);
	}
	const data = (await res.json()) as { raw: string };
	return data.raw;
}

export async function sendGmailRawMessage(opts: {
	accessToken: string;
	rawMessage: string;
	threadId?: string;
}) {
	const res = await fetch(`${API_BASE}/users/me/messages/send`, {
		method: "POST",
		headers: {
			...withBearer(opts.accessToken),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			raw: base64UrlEncode(opts.rawMessage),
			...(opts.threadId ? { threadId: opts.threadId } : {}),
		}),
	});
	if (!res.ok) {
		throw new Error(`Gmail send failed: ${await res.text()}`);
	}
	return res.json();
}
