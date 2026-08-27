import { LogtoProvider, useLogto } from "@logto/rn";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import "react-native-reanimated";
import { AuthScreen } from "@/src/auth/AuthScreen";
import { config } from "@/src/config";
import { AppProvider } from "@/src/data/context";
import { useAppTheme } from "@/src/theme";
import { NativeInteractionBridge } from "@/src/platform/NavigationBridge";

export { ErrorBoundary } from "expo-router";

export const unstable_settings = {
  initialRouteName: "(tabs)",
};

SplashScreen.preventAutoHideAsync();

const logtoConfig = {
  endpoint: config.authEndpoint,
  appId: config.logtoAppId,
  scopes: ["openid", "offline_access", "profile", "email"],
  resources: [config.apiResource],
};

export default function RootLayout() {
  // Logto's native storage adapter is intentionally not constructed during
  // Expo web static rendering. Native builds take the authenticated path.
  return Platform.OS === "web" ? <WebPreviewRoot /> : <LogtoProvider config={logtoConfig}><NativeRoot /></LogtoProvider>;
}

function WebPreviewRoot() {
  const theme = useAppTheme();
  return <AppProvider userUuid="web-preview" getAccessToken={async () => null} offline><Navigation theme={theme} /></AppProvider>;
}

function NativeRoot() {
  const { client, isInitialized, isAuthenticated, signIn } = useLogto();
  const theme = useAppTheme();
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [userUuid, setUserUuid] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated) {
      setUserUuid(null);
      return;
    }
    let active = true;
    void client.getIdTokenClaims().then((claims) => {
      if (active) setUserUuid(typeof claims.sub === "string" ? claims.sub : null);
    }).catch((error) => {
      if (active) setAuthError(error instanceof Error ? error.message : "Unable to read your account");
    });
    return () => { active = false; };
  }, [client, isAuthenticated]);

  const getAccessToken = useCallback(async () => {
    try {
      return await client.getAccessToken(config.apiResource);
    } catch {
      return null;
    }
  }, [client]);

  const handleSignIn = useCallback(async () => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      await signIn(config.redirectUri);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Sign in was not completed");
    } finally {
      setAuthLoading(false);
    }
  }, [signIn]);

  useEffect(() => {
    if (isInitialized) void SplashScreen.hideAsync();
  }, [isInitialized]);

  if (!isInitialized) return <LoadingScreen />;
  if (!isAuthenticated || !userUuid) return <AuthScreen onSignIn={handleSignIn} loading={authLoading} error={authError} />;
  return <AppProvider userUuid={userUuid} getAccessToken={getAccessToken}><Navigation theme={theme} /></AppProvider>;
}

function Navigation({ theme }: { theme: ReturnType<typeof useAppTheme> }) {
  return <ThemeProvider value={theme.mode === "dark" ? DarkTheme : DefaultTheme}>
    <StatusBar style={theme.mode === "dark" ? "light" : "dark"} />
    <NativeInteractionBridge />
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.colors.background } }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="chat/[sessionId]" options={{ animation: "slide_from_right" }} />
      <Stack.Screen name="space/[spaceId]" options={{ animation: "slide_from_right" }} />
      <Stack.Screen name="space/[spaceId]/files" options={{ animation: "slide_from_right" }} />
      <Stack.Screen name="space/[spaceId]/file" options={{ animation: "slide_from_right" }} />
      <Stack.Screen name="work/[appId]" options={{ animation: "slide_from_right" }} />
      <Stack.Screen name="new-chat" options={{ presentation: "modal", animation: "slide_from_bottom" }} />
    </Stack>
  </ThemeProvider>;
}

function LoadingScreen() {
  const theme = useAppTheme();
  return <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.background }}><ActivityIndicator size="small" color={theme.colors.accent} /></View>;
}
