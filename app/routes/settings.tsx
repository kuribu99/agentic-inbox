// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Loader, Select, useKumoToastManager } from "@cloudflare/kumo";
import { RobotIcon, ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";
import {
	useConnections,
	useCreateConnection,
	useDeleteConnection,
	useSyncConnection,
} from "~/queries/connections";

// Placeholder shown in the textarea when no custom prompt is set.
// The authoritative default prompt lives in workers/agent/index.ts (DEFAULT_SYSTEM_PROMPT).
const PROMPT_PLACEHOLDER = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations.\n\nWrite like a real person. Short, direct, flowing prose. Plain text only.\n\n(Leave empty to use the full built-in default prompt)`;

export default function SettingsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const toastManager = useKumoToastManager();
	const { data: mailbox } = useMailbox(mailboxId);
	const { data: connections } = useConnections(mailboxId);
	const updateMailboxMutation = useUpdateMailbox();
	const createConnectionMutation = useCreateConnection();
	const deleteConnectionMutation = useDeleteConnection();
	const syncConnectionMutation = useSyncConnection();

	const [displayName, setDisplayName] = useState("");
	const [agentPrompt, setAgentPrompt] = useState("");
	const [isSaving, setIsSaving] = useState(false);
	const [oauthEmail, setOauthEmail] = useState("");
	const [smtpEmail, setSmtpEmail] = useState("");
	const [smtpDisplayName, setSmtpDisplayName] = useState("");
	const [smtpProvider, setSmtpProvider] = useState<"smtp" | "lark">("smtp");
	const [smtpResult, setSmtpResult] = useState<{ url: string; token: string } | null>(null);

	useEffect(() => {
		if (mailbox) {
			setDisplayName(mailbox.settings?.fromName || mailbox.name || "");
			setAgentPrompt(mailbox.settings?.agentSystemPrompt || "");
			setOauthEmail(mailbox.email);
			setSmtpEmail(mailbox.email);
		}
	}, [mailbox]);

	const handleSave = async () => {
		if (!mailbox || !mailboxId) return;
		setIsSaving(true);
		const settings = {
			...mailbox.settings,
			fromName: displayName,
			agentSystemPrompt: agentPrompt.trim() || undefined,
		};
		try {
			await updateMailboxMutation.mutateAsync({ mailboxId, settings });
			toastManager.add({ title: "Settings saved!" });
		} catch {
			toastManager.add({
				title: "Failed to save settings",
				variant: "error",
			});
		} finally {
			setIsSaving(false);
		}
	};

	const handleResetPrompt = () => {
		setAgentPrompt("");
	};

	const handleConnectOAuth = async (provider: "gmail" | "outlook") => {
		if (!mailboxId || !mailbox) return;
		setSmtpResult(null);
		try {
			const email = oauthEmail.trim() || mailbox.email;
			const res = await createConnectionMutation.mutateAsync({
				mailboxId,
				payload: {
					provider,
					email,
					displayName: displayName || mailbox.settings?.fromName || mailbox.name,
					sendMode: "provider",
				},
			});
			if (res.authUrl) {
				window.location.href = res.authUrl;
				return;
			}
			toastManager.add({
				title: "Failed to start OAuth",
				variant: "error",
			});
		} catch {
			toastManager.add({
				title: "Failed to start OAuth",
				variant: "error",
			});
		}
	};

	const handleCreateSmtp = async () => {
		if (!mailboxId || !smtpEmail) return;
		setSmtpResult(null);
		try {
			const res = await createConnectionMutation.mutateAsync({
				mailboxId,
				payload: {
					provider: smtpProvider,
					email: smtpEmail,
					displayName: smtpDisplayName || undefined,
					sendMode: "cloudflare",
				},
			});
			if (res.ingestUrl && res.ingestToken) {
				setSmtpResult({ url: res.ingestUrl, token: res.ingestToken });
				toastManager.add({ title: "SMTP inbound created" });
			}
		} catch {
			toastManager.add({
				title: "Failed to create SMTP inbound",
				variant: "error",
			});
		}
	};

	if (!mailbox) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}

	const isCustomPrompt = agentPrompt.trim().length > 0;

	return (
		<div className="max-w-2xl px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto">
			<h1 className="text-lg font-semibold text-kumo-default mb-6">Settings</h1>

			<div className="space-y-6">
				{/* Account */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="text-sm font-medium text-kumo-default mb-4">
						Account
					</div>
					<div className="space-y-3">
						<Input
							label="Display Name"
							value={displayName}
							onChange={(e) => setDisplayName(e.target.value)}
						/>
						<Input label="Email" type="email" value={mailbox.email} disabled />
					</div>
				</div>

				{/* Agent System Prompt */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center justify-between mb-4">
						<div className="flex items-center gap-2">
							<RobotIcon size={16} weight="duotone" className="text-kumo-subtle" />
							<span className="text-sm font-medium text-kumo-default">
								AI Agent Prompt
							</span>
							{isCustomPrompt ? (
								<Badge variant="primary">Custom</Badge>
							) : (
								<Badge variant="secondary">Default</Badge>
							)}
						</div>

						{/* Connections */}
						<div className="rounded-lg border border-kumo-line bg-kumo-base p-5 space-y-4">
							<div className="text-sm font-medium text-kumo-default">
								Connections
							</div>
							<div className="space-y-2">
								<div className="text-xs text-kumo-subtle">
									Connect Gmail or Outlook accounts to sync multiple inboxes.
								</div>
								<Input
									label="OAuth account email"
									value={oauthEmail}
									onChange={(e) => setOauthEmail(e.target.value)}
								/>
							</div>
							<div className="flex flex-wrap gap-2">
								<Button
									variant="secondary"
									onClick={() => handleConnectOAuth("gmail")}
									loading={createConnectionMutation.isPending}
								>
									Connect Gmail
								</Button>
								<Button
									variant="secondary"
									onClick={() => handleConnectOAuth("outlook")}
									loading={createConnectionMutation.isPending}
								>
									Connect Outlook
								</Button>
							</div>

							<div className="space-y-3">
								<div className="text-xs text-kumo-subtle">
									Inbound SMTP (generic or Lark). Use the generated URL and token in your SMTP
									forwarder or external fetcher.
								</div>
								<div>
									<span className="text-xs font-medium text-kumo-default mb-1 block">
										Inbound provider
									</span>
									<Select
										aria-label="Inbound provider"
										value={smtpProvider}
										onValueChange={(value) => {
											if (value) setSmtpProvider(value as "smtp" | "lark");
										}}
									>
										<Select.Option value="smtp">SMTP (generic)</Select.Option>
										<Select.Option value="lark">Lark (SMTP)</Select.Option>
									</Select>
								</div>
								<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
									<Input
										label="Email"
										value={smtpEmail}
										onChange={(e) => setSmtpEmail(e.target.value)}
									/>
									<Input
										label="Display Name (optional)"
										value={smtpDisplayName}
										onChange={(e) => setSmtpDisplayName(e.target.value)}
									/>
								</div>
								<Button
									variant="primary"
									onClick={handleCreateSmtp}
									loading={createConnectionMutation.isPending}
								>
									Create SMTP Inbound
								</Button>
								{smtpResult && (
									<div className="rounded-md border border-kumo-line bg-kumo-recessed p-3 text-xs text-kumo-default">
										<div className="font-medium mb-1">SMTP Inbound Details</div>
										<div className="break-all">URL: {smtpResult.url}</div>
										<div className="break-all">Token: {smtpResult.token}</div>
									</div>
								)}
							</div>

							{connections && connections.length > 0 ? (
								<div className="space-y-3">
									{connections.map((conn) => (
										<div
											key={conn.id}
											className="flex flex-col gap-2 rounded-md border border-kumo-line bg-kumo-recessed p-3 text-xs md:flex-row md:items-center md:justify-between"
										>
											<div className="space-y-1">
												<div className="text-sm font-medium text-kumo-default">
													{conn.provider === "lark" ? "LARK (SMTP)" : conn.provider.toUpperCase()} ·{" "}
													{conn.email}
												</div>
												<div className="text-kumo-subtle">
													Send mode: {conn.sendMode} · Status: {conn.status}
												</div>
												{conn.lastSync && (
													<div className="text-kumo-subtle">
														Last sync: {new Date(conn.lastSync).toLocaleString()}
													</div>
												)}
												{conn.lastError && (
													<div className="text-kumo-error">Error: {conn.lastError}</div>
												)}
											</div>
											<div className="flex flex-wrap gap-2">
												{(conn.provider === "gmail" || conn.provider === "outlook") && (
													<Button
														variant="secondary"
														size="xs"
														onClick={() =>
															syncConnectionMutation.mutate({
																mailboxId: mailboxId!,
																connectionId: conn.id,
															})
														}
														loading={syncConnectionMutation.isPending}
													>
														Sync now
													</Button>
												)}
												<Button
													variant="ghost"
													size="xs"
													onClick={() =>
														deleteConnectionMutation.mutate({
															mailboxId: mailboxId!,
															connectionId: conn.id,
														})
													}
													loading={deleteConnectionMutation.isPending}
												>
													Disconnect
												</Button>
											</div>
										</div>
									))}
								</div>
							) : (
								<div className="text-xs text-kumo-subtle">
									No connections configured yet.
								</div>
							)}
						</div>
						{isCustomPrompt && (
							<Button
								variant="ghost"
								size="xs"
								icon={<ArrowCounterClockwiseIcon size={14} />}
								onClick={handleResetPrompt}
							>
								Reset to default
							</Button>
						)}
					</div>
					<p className="text-xs text-kumo-subtle mb-3">
						Customize how the AI agent behaves for this mailbox.
						Leave empty to use the built-in default prompt.
					</p>
					<textarea
						value={agentPrompt}
						onChange={(e) => setAgentPrompt(e.target.value)}
						placeholder={PROMPT_PLACEHOLDER}
						rows={12}
						className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring font-mono leading-relaxed"
					/>
					<p className="text-xs text-kumo-subtle mt-2">
						The prompt is sent as the system message to the AI model.
						It controls the agent's personality, writing style, and behavior rules.
					</p>
				</div>

				{/* Save */}
				<div className="flex justify-end">
					<Button variant="primary" onClick={handleSave} loading={isSaving}>
						Save Changes
					</Button>
				</div>
			</div>
		</div>
	);
}
