import { LogtoProvider, useLogto } from "@logto/rn";
import { useFonts } from "expo-font";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
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
  // Code blocks, the file viewer, and the code editor all reference "SpaceMono";
  // keep the splash up until the bundled font is registered.
  const [fontsLoaded, fontError] = useFonts({ SpaceMono: require("../assets/fonts/SpaceMono-Regular.ttf") });
  if (!fontsLoaded && !fontError) return null;
  return <LogtoProvider config={logtoConfig}><NativeRoot /></LogtoProvider>;
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
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style={theme.mode === "dark" ? "light" : "dark"} />
      <NativeInteractionBridge />
      <View style={{ flex: 1 }}>
        {/* Deeper screens use the platform transition: the iOS push (with its interactive back
            swipe) and Android's own forward animation. Overriding it replaces a platform behavior
            with an imitation. */}
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.colors.background } }}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="chat/[sessionId]" />
          <Stack.Screen name="space/[spaceId]" />
          <Stack.Screen name="space/[spaceId]/files" />
          <Stack.Screen name="space/[spaceId]/file" />
          <Stack.Screen name="work/[appId]" />
          <Stack.Screen name="image-viewer" options={{ contentStyle: { backgroundColor: "#000000" } }} />
          <Stack.Screen name="new-chat" options={{ title: "New Chat", presentation: "modal", animation: "slide_from_bottom" }} />
          <Stack.Screen name="profile" options={{ title: "Profile" }} />
          <Stack.Screen name="settings" options={{ title: "Settings" }} />
          <Stack.Screen name="appearance" options={{ title: "Appearance" }} />
          <Stack.Screen name="about" options={{ title: "About" }} />
          <Stack.Screen name="debug/index" options={{ title: "Debug" }} />
          <Stack.Screen name="debug/streaming" options={{ title: "Streaming" }} />
          <Stack.Screen name="debug/tools" options={{ title: "Tools" }} />
          <Stack.Screen name="debug/markdown" options={{ title: "Markdown" }} />
          <Stack.Screen name="debug/list" options={{ title: "Long List" }} />
        </Stack>
        <AppUpdateBanner />
      </View>
    </GestureHandlerRootView>
  </ThemeProvider>;
}

function LoadingScreen() {
  const theme = useAppTheme();
  return <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.background }}><ActivityIndicator size="small" color={theme.colors.accent} /></View>;
}
