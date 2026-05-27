import { describe, expect, it } from "bun:test";
import { app } from "../../workers/index";
import { encryptJson } from "../../workers/lib/crypto";
import { sendOutgoingEmail } from "../../workers/lib/outgoing";

class InMemoryBucket {
	private store = new Map<string, string>();

	async head(key: string) {
		return this.store.has(key) ? { key } : null;
	}

	async get(key: string) {
		const value = this.store.get(key);
		if (!value) return null;
		return {
			json: async () => JSON.parse(value),
			text: async () => value,
		};
	}

	async put(key: string, value: string) {
		this.store.set(key, value);
	}
}

class InMemoryMailboxNamespace {
	private secrets = new Map<string, { provider: string; encrypted: string }>();

	getSecrets() {
		return this.secrets;
	}

	idFromName(name: string) {
		return name;
	}

	get() {
		return {
			setConnectionSecret: async (id: string, provider: string, encrypted: string) => {
				this.secrets.set(id, { provider, encrypted });
			},
			getConnectionSecret: async (id: string) => this.secrets.get(id) ?? null,
			getFolders: async () => [],
		};
	}
}

function createEnv() {
	const bucket = new InMemoryBucket();
	const mailboxNamespace = new InMemoryMailboxNamespace();
	const base64Key = Buffer.from(
		crypto.getRandomValues(new Uint8Array(32)),
	).toString("base64");
	const env = {
		BUCKET: bucket,
		MAILBOX: mailboxNamespace,
		PUBLIC_BASE_URL: "https://example.com",
		CONNECTIONS_KEY: base64Key,
		OAUTH_GMAIL_CLIENT_ID: "test-client",
		OAUTH_GMAIL_CLIENT_SECRET: "test-secret",
		EMAIL: { send: async () => ({ messageId: "test" }) },
	};
	return { env, bucket, mailboxNamespace };
}

describe("Gmail connection integration", () => {
	it("stores multiple Gmail connections for a mailbox", async () => {
		const { env, bucket } = createEnv();
		const mailboxId = "alpha@example.com";
		await bucket.put(
			`mailboxes/${mailboxId}.json`,
			JSON.stringify({ connections: [] }),
		);
		const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };

		const firstRes = await app.fetch(
			new Request(
				`https://example.com/api/v1/mailboxes/${mailboxId}/connections`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						provider: "gmail",
						email: "first@gmail.com",
						displayName: "First",
					}),
				},
			),
			env as any,
			ctx as any,
		);
		expect(firstRes.status).toBe(201);
		const firstBody = await firstRes.json();

		const secondRes = await app.fetch(
			new Request(
				`https://example.com/api/v1/mailboxes/${mailboxId}/connections`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						provider: "gmail",
						email: "second@gmail.com",
						displayName: "Second",
					}),
				},
			),
			env as any,
			ctx as any,
		);
		expect(secondRes.status).toBe(201);
		const secondBody = await secondRes.json();
		expect(firstBody.connection.id).not.toBe(secondBody.connection.id);

		const stored = await bucket.get(`mailboxes/${mailboxId}.json`);
		const settings = stored ? await stored.json() : null;
		expect(settings?.connections?.length).toBe(2);
		expect(settings?.connections?.map((c: { email: string }) => c.email)).toEqual(
			expect.arrayContaining(["first@gmail.com", "second@gmail.com"]),
		);
	});

	it("selects the matching Gmail connection when sending", async () => {
		const { env, bucket, mailboxNamespace } = createEnv();
		const mailboxId = "beta@example.com";
		const connectionA = {
			id: "gmail_a",
			provider: "gmail",
			email: "first@gmail.com",
			status: "connected",
			sendMode: "provider",
		};
		const connectionB = {
			id: "gmail_b",
			provider: "gmail",
			email: "second@gmail.com",
			status: "connected",
			sendMode: "provider",
		};
		await bucket.put(
			`mailboxes/${mailboxId}.json`,
			JSON.stringify({ connections: [connectionA, connectionB] }),
		);

		const secrets = mailboxNamespace.getSecrets();
		secrets.set(connectionA.id, {
			provider: "gmail",
			encrypted: await encryptJson(env as any, {
				kind: "oauth",
				accessToken: "gmail-one",
			}),
		});
		secrets.set(connectionB.id, {
			provider: "gmail",
			encrypted: await encryptJson(env as any, {
				kind: "oauth",
				accessToken: "gmail-two",
			}),
		});

		let seenAuth: string | undefined;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (_input, init) => {
			const headers = init?.headers as Record<string, string> | undefined;
			seenAuth = headers?.Authorization || headers?.authorization;
			return new Response(JSON.stringify({ id: "ok" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		try {
			await sendOutgoingEmail({
				env: env as any,
				mailboxId,
				message: {
					to: "recipient@example.com",
					from: "second@gmail.com",
					subject: "Hello",
					text: "Test",
				},
			});
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(seenAuth?.endsWith("gmail-two")).toBe(true);
	});
});
