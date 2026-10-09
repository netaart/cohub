import AsyncStorage from "@react-native-async-storage/async-storage";
import type { CohubEnvironment } from "@/src/config";

const STORAGE_KEY = "cohub:mobile:environment:v1";

/** Unknown or missing values fall back to the build-time environment. */
export function parseEnvironmentPreference(value: string | null): CohubEnvironment | null {
  return value === "prod" || value === "dev" ? value : null;
}

export async function loadEnvironmentPreference(): Promise<CohubEnvironment | null> {
  return parseEnvironmentPreference(await AsyncStorage.getItem(STORAGE_KEY));
}

export async function saveEnvironmentPreference(environment: CohubEnvironment): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, environment);
}
