// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Env } from "../types";
import { decryptJson, encryptJson } from "./crypto";

export function base64UrlEncode(input: Uint8Array | string): string {
	const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlDecode(input: string): Uint8Array {
	const padded = input.replace(/-/g, "+").replace(/_/g, "/");
	const padLen = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4);
	const withPadding = padded + "=".repeat(padLen);
	const binary = atob(withPadding);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

export async function generatePkcePair() {
	const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
	const verifier = base64UrlEncode(verifierBytes);
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);
	const challenge = base64UrlEncode(new Uint8Array(digest));
	return { verifier, challenge };
}

export async function encodeState(env: Env, payload: unknown): Promise<string> {
	const encrypted = await encryptJson(env, payload);
	return base64UrlEncode(encrypted);
}

export async function decodeState<T>(env: Env, state: string): Promise<T> {
	const decoded = new TextDecoder().decode(base64UrlDecode(state));
	return decryptJson<T>(env, decoded);
}
