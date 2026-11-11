import type {
	BillingBalanceActivity,
	BillingBalanceActivityFilter,
} from "@neta-art/cohub";
import { ActivityFeed } from "$lib/features/billing/activity-feed.svelte";
import { AccountResource } from "$lib/features/settings/account-resource.svelte";
import { sdk } from "$lib/sdk";

export const billingCredits = new AccountResource("billing-credits", () =>
	sdk.billing.getCredits(),
);

export type BillingActivityFilter = BillingBalanceActivityFilter | "all";

const billingActivityFeeds = new Map<
	BillingActivityFilter,
	ActivityFeed<BillingBalanceActivity>
>();

export function billingActivity(filter: BillingActivityFilter) {
	let feed = billingActivityFeeds.get(filter);
	if (!feed) {
		const name =
			filter === "all" ? "billing-activity" : `billing-activity:${filter}`;
		feed = new ActivityFeed(name, (cursor) =>
			sdk.billing
				.getBalanceActivities({
					cursor,
					filter: filter === "all" ? undefined : filter,
				})
				.then(({ activities }) => activities),
		);
		billingActivityFeeds.set(filter, feed);
	}
	return feed;
}

export const referrals = new AccountResource("referrals-v2", () =>
	sdk.referrals.getMine(),
);

export const channels = new AccountResource("channels", () =>
	sdk.channels.list(),
);

export const rules = new AccountResource("home-rules", () =>
	sdk.user.getRules(),
);
