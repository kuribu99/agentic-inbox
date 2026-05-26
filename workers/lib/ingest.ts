// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import PostalMime from "postal-mime";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";
import type { ConnectionProvider } from "./connections";

export const MAX_EMAIL_SIZE = 25 * 1024 * 1024;

export type IngestSource = {
	provider?: ConnectionProvider | "routing" | "smtp" | "imap";
	messageId?: string;
	threadId?: string;
	folderId?: string;
	accountId?: string;
};

function extractMessageId(value: string) {
	const match = value.match(/<([^>]+)>/);
	return match ? match[1] : value.trim().split(/\s+/)[0];
}

export async function streamToArrayBuffer(
	stream: ReadableStream,
	streamSize: number,
) {
	if (streamSize > MAX_EMAIL_SIZE) {
		throw new Error(
			`Email too large: ${streamSize} bytes exceeds ${MAX_EMAIL_SIZE} byte limit`,
		);
	}
	if (streamSize <= 0) throw new Error(`Invalid stream size: ${streamSize}`);
	const result = new Uint8Array(streamSize);
	let bytesRead = 0;
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (bytesRead + value.length > streamSize) {
			reader.cancel();
			throw new Error("Stream exceeds declared size");
		}
		result.set(value, bytesRead);
		bytesRead += value.length;
	}
	return result;
}

export async function bufferFromRequest(req: Request) {
	const buffer = new Uint8Array(await req.arrayBuffer());
	if (buffer.byteLength > MAX_EMAIL_SIZE) {
		throw new Error(
			`Email too large: ${buffer.byteLength} bytes exceeds ${MAX_EMAIL_SIZE} byte limit`,
		);
	}
	return buffer;
}

export async function ingestRawEmail(params: {
	env: Env;
	ctx: ExecutionContext;
	mailboxId: string;
	raw: Uint8Array;
	source?: IngestSource;
}): Promise<{ id: string; status: "ingested" | "duplicate" }> {
	const { env, ctx, mailboxId, raw, source } = params;
	const parsedEmail = await new PostalMime().parse(raw);

	const allRecipients = (parsedEmail.to || [])
		.map((t) => t.address?.toLowerCase())
		.filter(Boolean) as string[];
	const ccRecipients = (parsedEmail.cc || [])
		.map((e) => e.address?.toLowerCase())
		.filter(Boolean) as string[];
	const bccRecipients = (parsedEmail.bcc || [])
		.map((e) => e.address?.toLowerCase())
		.filter(Boolean) as string[];

	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId)) as unknown as {
		findEmailBySource: (provider: string, messageId: string) => Promise<string | null>;
		findThreadBySubject: (subject: string, sender?: string) => Promise<string | null>;
		createEmail: (
			folder: string,
			email: Record<string, unknown>,
			attachments: Record<string, unknown>[],
		) => Promise<void>;
	};

	if (source?.provider && source.messageId) {
		const existing = await stub.findEmailBySource(
			source.provider,
			source.messageId,
		);
		if (existing) {
			return { id: existing, status: "duplicate" };
		}
	}

	const messageId = crypto.randomUUID();

	const attachmentData: Array<{
		id: string;
		email_id: string;
		filename: string;
		mimetype: string;
		size: number;
		content_id: string | null;
		disposition: string | null;
	}> = [];
	if (parsedEmail.attachments) {
		for (const att of parsedEmail.attachments) {
			const attId = crypto.randomUUID();
			const filename = (att.filename || "untitled").replace(
				/[\/\\:*?"<>|\x00-\x1f]/g,
				"_",
			);
			await env.BUCKET.put(
				`attachments/${messageId}/${attId}/${filename}`,
				att.content,
			);
			attachmentData.push({
				id: attId,
				email_id: messageId,
				filename,
				mimetype: att.mimeType,
				size:
					typeof att.content === "string"
						? att.content.length
						: att.content.byteLength,
				content_id: att.contentId || null,
				disposition: att.disposition || "attachment",
			});
		}
	}

	const inReplyTo = parsedEmail.inReplyTo
		? extractMessageId(parsedEmail.inReplyTo)
		: null;
	const emailReferences = parsedEmail.references
		? parsedEmail.references
				.split(/\s+/)
				.filter(Boolean)
				.map(extractMessageId)
		: [];
	let threadId = source?.threadId || emailReferences[0] || inReplyTo || messageId;

	if (!source?.threadId && !inReplyTo && emailReferences.length === 0) {
		const subjectThread = await stub.findThreadBySubject(
			parsedEmail.subject || "",
			parsedEmail.from?.address || undefined,
		);
		if (subjectThread) threadId = subjectThread;
	}

	const originalMessageId = parsedEmail.messageId
		? extractMessageId(parsedEmail.messageId)
		: null;

	const knownFolders = new Set(Object.values(Folders));
	const folder =
		source?.folderId && knownFolders.has(source.folderId)
			? source.folderId
			: Folders.INBOX;

	await stub.createEmail(
		folder,
		{
			id: messageId,
			subject: parsedEmail.subject || "",
			sender: (parsedEmail.from?.address || "").toLowerCase(),
			recipient: allRecipients.join(", "),
			cc: ccRecipients.join(", ") || null,
			bcc: bccRecipients.join(", ") || null,
			date: new Date().toISOString(),
			body: parsedEmail.html || parsedEmail.text || "",
			in_reply_to: inReplyTo,
			email_references:
				emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
			thread_id: threadId,
			message_id: originalMessageId,
			raw_headers: JSON.stringify(parsedEmail.headers),
			source_provider: source?.provider ?? null,
			source_message_id: source?.messageId ?? null,
			source_thread_id: source?.threadId ?? null,
			source_folder_id: source?.folderId ?? null,
			source_account_id: source?.accountId ?? null,
		},
		attachmentData,
	);

	const agentStub = env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(mailboxId));
	ctx.waitUntil(
		agentStub
			.fetch(
				new Request("https://agents/onNewEmail", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						mailboxId,
						emailId: messageId,
						sender: (parsedEmail.from?.address || "").toLowerCase(),
						subject: parsedEmail.subject || "",
						threadId,
					}),
				}),
			)
			.catch((e) =>
				console.error("Auto-draft trigger failed:", (e as Error).message),
			),
	);

	return { id: messageId, status: "ingested" };
}
