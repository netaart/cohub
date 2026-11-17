import { defineEnvVars } from "@sveltejs/kit/env";

const optional = (value: string | undefined) => value?.trim() || undefined;

export const variables = defineEnvVars({
	PUBLIC_COHUB_ENV: { public: true, static: true },
	PUBLIC_API_ORIGIN: { public: true, static: true },
	PUBLIC_GATEWAY_ORIGIN: { public: true, static: true },
	PUBLIC_FILES_ORIGIN: { public: true, static: true },
	PUBLIC_APP_STANDALONE_HOST_TEMPLATE: { public: true, static: true },
	PUBLIC_PREVIEW_ORIGIN: { public: true, static: true, schema: optional },
	PUBLIC_MARKETPLACE_APP_ID: { public: true, static: true, schema: optional },
	PUBLIC_LOGTO_ENDPOINT: { public: true, static: true, schema: optional },
	PUBLIC_LOGTO_APP_ID: { public: true, static: true, schema: optional },
	PUBLIC_LOGTO_API_RESOURCE: { public: true, static: true, schema: optional },
	PUBLIC_LANDING_MEDIA_BASE: { public: true, static: true, schema: optional },
});
