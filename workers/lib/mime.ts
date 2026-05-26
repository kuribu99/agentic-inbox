// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

type AddressInput = string | string[];

export interface MimeAttachment {
	content: string; // base64
	filename: string;
	type: string;
	disposition: "attachment" | "inline";
	contentId?: string;
}

export interface MimeMessageInput {
	from: string | { email: string; name: string };
	to: AddressInput;
	cc?: AddressInput;
	bcc?: AddressInput;
	subject: string;
	text?: string;
	html?: string;
	headers?: Record<string, string>;
	attachments?: MimeAttachment[];
}

function formatAddress(input: string | { email: string; name: string }) {
	if (typeof input === "string") return input;
	return `${input.name} <${input.email}>`;
}

function formatAddressList(input?: AddressInput) {
	if (!input) return "";
	return Array.isArray(input) ? input.join(", ") : input;
}

function wrapBase64(value: string) {
	return value.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function joinLines(lines: string[]) {
	return lines.filter((line) => line !== undefined).join("\r\n");
}

export function buildMimeMessage(input: MimeMessageInput): string {
	const headers: string[] = [
		`From: ${formatAddress(input.from)}`,
		`To: ${formatAddressList(input.to)}`,
		...(input.cc ? [`Cc: ${formatAddressList(input.cc)}`] : []),
		...(input.bcc ? [`Bcc: ${formatAddressList(input.bcc)}`] : []),
		`Subject: ${input.subject}`,
		"MIME-Version: 1.0",
		`Date: ${new Date().toUTCString()}`,
	];

	if (input.headers) {
		for (const [key, value] of Object.entries(input.headers)) {
			headers.push(`${key}: ${value}`);
		}
	}

	const hasText = Boolean(input.text);
	const hasHtml = Boolean(input.html);
	const attachments = input.attachments ?? [];

	if (attachments.length === 0 && !hasHtml) {
		return joinLines([
			...headers,
			"Content-Type: text/plain; charset=UTF-8",
			"Content-Transfer-Encoding: 7bit",
			"",
			input.text || "",
		]);
	}

	const altBoundary = `alt_${crypto.randomUUID()}`;
	const mixedBoundary = `mixed_${crypto.randomUUID()}`;

	if (attachments.length > 0) {
		const parts: string[] = [];
		if (hasText && hasHtml) {
			parts.push(
				`--${mixedBoundary}`,
				`Content-Type: multipart/alternative; boundary="${altBoundary}"`,
				"",
				`--${altBoundary}`,
				"Content-Type: text/plain; charset=UTF-8",
				"Content-Transfer-Encoding: 7bit",
				"",
				input.text || "",
				"",
				`--${altBoundary}`,
				"Content-Type: text/html; charset=UTF-8",
				"Content-Transfer-Encoding: 7bit",
				"",
				input.html || "",
				"",
				`--${altBoundary}--`,
				"",
			);
		} else {
			const isHtml = hasHtml;
			parts.push(
				`--${mixedBoundary}`,
				`Content-Type: ${isHtml ? "text/html" : "text/plain"}; charset=UTF-8`,
				"Content-Transfer-Encoding: 7bit",
				"",
				isHtml ? input.html || "" : input.text || "",
				"",
			);
		}

		for (const att of attachments) {
			parts.push(
				`--${mixedBoundary}`,
				`Content-Type: ${att.type}; name="${att.filename}"`,
				"Content-Transfer-Encoding: base64",
				`Content-Disposition: ${att.disposition}; filename="${att.filename}"`,
				...(att.contentId ? [`Content-ID: <${att.contentId}>`] : []),
				"",
				wrapBase64(att.content),
				"",
			);
		}

		parts.push(`--${mixedBoundary}--`);

		return joinLines([
			...headers,
			`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
			"",
			...parts,
		]);
	}

	if (hasText && hasHtml) {
		return joinLines([
			...headers,
			`Content-Type: multipart/alternative; boundary="${altBoundary}"`,
			"",
			`--${altBoundary}`,
			"Content-Type: text/plain; charset=UTF-8",
			"Content-Transfer-Encoding: 7bit",
			"",
			input.text || "",
			"",
			`--${altBoundary}`,
			"Content-Type: text/html; charset=UTF-8",
			"Content-Transfer-Encoding: 7bit",
			"",
			input.html || "",
			"",
			`--${altBoundary}--`,
		]);
	}

	return joinLines([
		...headers,
		`Content-Type: text/html; charset=UTF-8`,
		"Content-Transfer-Encoding: 7bit",
		"",
		input.html || "",
	]);
}
