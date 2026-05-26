// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Env } from "../types";

const KEY_BYTES = 32;
const IV_BYTES = 12;

function decodeBase64(input: string): Uint8Array {
	const padded = input.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

async function getAesKey(env: Env): Promise<CryptoKey> {
	if (!env.CONNECTIONS_KEY) {
		throw new Error("CONNECTIONS_KEY is required to encrypt connection secrets");
	}
	const raw = decodeBase64(env.CONNECTIONS_KEY);
	if (raw.byteLength !== KEY_BYTES) {
		throw new Error("CONNECTIONS_KEY must be 32 bytes base64-encoded");
	}
	return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
		"encrypt",
		"decrypt",
	]);
}

export async function encryptJson(env: Env, payload: unknown): Promise<string> {
	const key = await getAesKey(env);
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const encoded = new TextEncoder().encode(JSON.stringify(payload));
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded),
	);
	const packed = {
		iv: encodeBase64(iv),
		data: encodeBase64(ciphertext),
	};
	return JSON.stringify(packed);
}

export async function decryptJson<T>(env: Env, packed: string): Promise<T> {
	const key = await getAesKey(env);
	const parsed = JSON.parse(packed) as { iv: string; data: string };
	const iv = decodeBase64(parsed.iv);
	const data = decodeBase64(parsed.data);
	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv },
		key,
		data,
	);
	return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
