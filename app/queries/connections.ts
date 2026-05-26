// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { MailboxConnection } from "~/types";
import { queryKeys } from "./keys";

export function useConnections(mailboxId: string | undefined) {
	return useQuery<MailboxConnection[]>({
		queryKey: mailboxId
			? queryKeys.connections.list(mailboxId)
			: ["connections", "_disabled"],
		queryFn: () => api.listConnections(mailboxId!) as Promise<MailboxConnection[]>,
		enabled: !!mailboxId,
	});
}

export function useCreateConnection() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			payload,
		}: { mailboxId: string; payload: unknown }) =>
			api.createConnection(mailboxId, payload) as Promise<{
				connection: MailboxConnection;
				authUrl?: string;
				ingestUrl?: string;
				ingestToken?: string;
			}>,
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.connections.list(mailboxId) });
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.detail(mailboxId) });
		},
	});
}

export function useDeleteConnection() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			connectionId,
		}: { mailboxId: string; connectionId: string }) =>
			api.deleteConnection(mailboxId, connectionId),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.connections.list(mailboxId) });
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.detail(mailboxId) });
		},
	});
}

export function useSyncConnection() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			connectionId,
		}: { mailboxId: string; connectionId: string }) =>
			api.syncConnection(mailboxId, connectionId),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.connections.list(mailboxId) });
		},
	});
}
