// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
	CONNECTIONS_KEY: string;
	PUBLIC_BASE_URL?: string;
	OAUTH_GMAIL_CLIENT_ID?: string;
	OAUTH_GMAIL_CLIENT_SECRET?: string;
	OAUTH_OUTLOOK_CLIENT_ID?: string;
	OAUTH_OUTLOOK_CLIENT_SECRET?: string;
	OAUTH_OUTLOOK_TENANT?: string;
	INBOUND_SHARED_SECRET?: string;
}
