import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const INSTALLATION_KEY = "cohub:mobile:installation-id:v1";

export async function getInstallationId() {
  const existing =
    Platform.OS === "web"
      ? await AsyncStorage.getItem(INSTALLATION_KEY)
      : await SecureStore.getItemAsync(INSTALLATION_KEY);
  if (existing?.trim()) return existing;

  const generated = Crypto.randomUUID();
  if (Platform.OS === "web") {
    await AsyncStorage.setItem(INSTALLATION_KEY, generated);
  } else {
    await SecureStore.setItemAsync(INSTALLATION_KEY, generated);
  }
  return generated;
}
