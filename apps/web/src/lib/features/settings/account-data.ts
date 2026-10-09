import { CONFIG_SPACE_SLUG } from "@cohub/protocol/public-identifiers";
import { HttpError } from "@neta-art/cohub";
import { AccountResource } from "$lib/features/settings/account-resource.svelte";
import { sdk } from "$lib/sdk";
import { cacheSpaceRecordSoon } from "$lib/stores/space-record-cache";

export const BALANCE_ACTIVITY_PAGE_SIZE = 10;

export const billingCredits = new AccountResource("billing-credits", () =>
	sdk.billing.getCredits(),
);

export const billingActivity = new AccountResource("billing-activity", () =>
	sdk.billing
		.getBalanceActivities({ page: 1, limit: BALANCE_ACTIVITY_PAGE_SIZE })
		.then(({ activities }) => activities),
);

export const referrals = new AccountResource("referrals", () =>
	sdk.referrals.getMine(),
);

export const channels = new AccountResource("channels", () =>
	sdk.channels.list(),
);

async function findConfigSpace() {
	try {
		return await sdk.spaces.getOwnedBySlug(CONFIG_SPACE_SLUG);
	} catch (error) {
		if (error instanceof HttpError && error.status === 404) return null;
		throw error;
	}
}

export const rules = new AccountResource("rules", async () => {
	const [published, configSpace] = await Promise.all([
		sdk.user.getRules(),
		findConfigSpace(),
	]);
	cacheSpaceRecordSoon(configSpace);
	return { published, configSpace };
});
