import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

const INSTALLATION_KEY = "cohub:mobile:installation-id:v1";

async function mirrorInstallationId(value: string) {
  try {
    await AsyncStorage.setItem(INSTALLATION_KEY, value);
  } catch {
    // AsyncStorage is only a recovery copy when SecureStore is available.
  }
}

async function readStoredInstallationId() {
  try {
    const secureValue = await SecureStore.getItemAsync(INSTALLATION_KEY);
    if (secureValue?.trim()) {
      await mirrorInstallationId(secureValue);
      return secureValue;
    }
  } catch {
    // Continue to the non-secure store when the native keychain is unavailable.
  }
  return AsyncStorage.getItem(INSTALLATION_KEY);
}

async function storeInstallationId(value: string) {
  try {
    await SecureStore.setItemAsync(INSTALLATION_KEY, value);
    await mirrorInstallationId(value);
  } catch {
    await AsyncStorage.setItem(INSTALLATION_KEY, value);
  }
}

export async function getInstallationId() {
  const existing = await readStoredInstallationId();
  if (existing?.trim()) return existing;

  const generated = Crypto.randomUUID();
  await storeInstallationId(generated);
  return generated;
}
