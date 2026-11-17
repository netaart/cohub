import {
	type CohubAppHostTemplate,
	parseCohubAppHostTemplate,
} from "@cohub/protocol";
import { PUBLIC_APP_STANDALONE_HOST_TEMPLATE } from "$app/env/public";

/**
 * Hostname template for published App standalone origins, from deployment
 * configuration. Null keeps standalone origins disabled.
 */
export const standaloneAppHostTemplate: CohubAppHostTemplate | null =
	parseCohubAppHostTemplate(PUBLIC_APP_STANDALONE_HOST_TEMPLATE);
