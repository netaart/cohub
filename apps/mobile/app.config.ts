import type { ConfigContext, ExpoConfig } from "expo/config";

export default ({ config }: ConfigContext): ExpoConfig => {
  const owner = process.env.EXPO_OWNER?.trim();
  const projectId = process.env.EXPO_PROJECT_ID?.trim();
  return {
    ...config,
    ...(owner ? { owner } : {}),
    extra: {
      ...config.extra,
      ...(projectId
        ? {
            eas: { projectId },
          }
        : {}),
    },
  } as ExpoConfig;
};
