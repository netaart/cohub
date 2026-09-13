import * as WebBrowser from "expo-web-browser";
import { Linking } from "react-native";
import { loadBrowserPreference, getBrowserPreferenceSnapshot, saveBrowserPreference, subscribeBrowserPreference, type BrowserPreference } from "@/src/data/browser-preference";

export { getBrowserPreferenceSnapshot, loadBrowserPreference, saveBrowserPreference, subscribeBrowserPreference };
export type { BrowserPreference };

export function isWebLink(value: string) {
  return /^https?:\/\/[^\s]+$/i.test(value.trim());
}

export async function openWebLink(value: string) {
  const url = value.trim();
  if (!isWebLink(url)) throw new Error("Only absolute HTTP(S) URLs can be opened as web links.");
  const browserPreference = await loadBrowserPreference();
  if (browserPreference === "in-app") {
    await WebBrowser.openBrowserAsync(url);
    return;
  }
  await Linking.openURL(url);
}
