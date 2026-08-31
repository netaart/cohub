import { LogtoProvider, useLogto } from "@logto/rn";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import "react-native-reanimated";
import { AuthScreen } from "@/src/auth/AuthScreen";
import { AppUpdateBanner } from "@/src/components/AppUpdateBanner";
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

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 10_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs / 1000} seconds`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

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
  const { client, isInitialized, isAuthenticated, signIn, signOut } = useLogto();
  const theme = useAppTheme();
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<{ authenticated: boolean; uuid: string | null }>(() => ({ authenticated: isAuthenticated, uuid: null }));
  const [identityAttempt, setIdentityAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    if (!isAuthenticated) {
      void Promise.resolve().then(() => {
        if (active) setIdentity({ authenticated: false, uuid: null });
      });
      return () => { active = false; };
    }
    void withTimeout(client.getAccessTokenClaims(config.apiResource), "Reading account identity").then((claims) => {
      const userUuid = typeof claims.talesofai_uuid === "string" && claims.talesofai_uuid.trim()
        ? claims.talesofai_uuid.trim()
        : null;
      if (!userUuid) throw new Error("Your account identity is missing. Please sign in again.");
      if (active) {
        setAuthError(null);
        setIdentity({ authenticated: true, uuid: userUuid });
      }
    }).catch((error) => {
      if (active) {
        setAuthError(error instanceof Error ? error.message : "Unable to read your account");
        setIdentity({ authenticated: true, uuid: null });
      }
    });
    return () => { active = false; };
  }, [client, identityAttempt, isAuthenticated]);

  const getAccessToken = useCallback(async (options?: { forceRefresh?: boolean }) => {
    try {
      if (options?.forceRefresh) await client.clearAccessToken();
      return await withTimeout(client.getAccessToken(config.apiResource), "Loading sign-in token").catch(() => null);
    } catch {
      return null;
    }
  }, [client]);

  const handleSignIn = useCallback(async () => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      if (isAuthenticated) await signOut();
      await signIn(config.redirectUri);
      setIdentityAttempt((attempt) => attempt + 1);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Sign in was not completed");
    } finally {
      setAuthLoading(false);
    }
  }, [isAuthenticated, signIn, signOut]);

  useEffect(() => {
    if (isInitialized) void SplashScreen.hideAsync();
  }, [isInitialized]);

  if (!isInitialized) return <LoadingScreen />;
  if (!isAuthenticated || (authError && !identity.uuid)) return <AuthScreen onSignIn={handleSignIn} loading={authLoading} error={authError} />;
  if (identity.authenticated !== isAuthenticated || !identity.uuid) return <LoadingScreen />;
  return <AppProvider userUuid={identity.uuid} getAccessToken={getAccessToken}><Navigation theme={theme} /></AppProvider>;
}

function Navigation({ theme }: { theme: ReturnType<typeof useAppTheme> }) {
  return <ThemeProvider value={theme.mode === "dark" ? DarkTheme : DefaultTheme}>
    <StatusBar style={theme.mode === "dark" ? "light" : "dark"} />
    <NativeInteractionBridge />
    <View style={{ flex: 1 }}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.colors.background } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="chat/[sessionId]" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="space/[spaceId]" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="space/[spaceId]/files" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="space/[spaceId]/file" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="work/[appId]" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="new-chat" options={{ presentation: "modal", animation: "slide_from_bottom" }} />
      </Stack>
      <AppUpdateBanner />
    </View>
  </ThemeProvider>;
}

function LoadingScreen() {
  const theme = useAppTheme();
  return <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.background }}><ActivityIndicator size="small" color={theme.colors.accent} /></View>;
}
