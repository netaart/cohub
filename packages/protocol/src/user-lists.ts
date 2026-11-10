export const USER_APP_FILTERS = ["mine", "all", "disabled"] as const;
export type UserAppFilter = (typeof USER_APP_FILTERS)[number];

export const USER_CRONJOB_FILTERS = ["mine", "all", "paused", "attention"] as const;
export type UserCronJobFilter = (typeof USER_CRONJOB_FILTERS)[number];

export const isUserAppFilter = (value: unknown): value is UserAppFilter =>
  USER_APP_FILTERS.includes(value as UserAppFilter);

export const isUserCronJobFilter = (value: unknown): value is UserCronJobFilter =>
  USER_CRONJOB_FILTERS.includes(value as UserCronJobFilter);
