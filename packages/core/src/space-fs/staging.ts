export const SPACE_FS_STAGING_PREFIX = ".cohub-upload.";

export const isSpaceFsStagingName = (name: string) => name.startsWith(SPACE_FS_STAGING_PREFIX);
