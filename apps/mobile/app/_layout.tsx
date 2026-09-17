import { translate } from "@/src/i18n/core";
import { LogtoProvider, useLogto } from "@logto/rn";
import type { UnauthorizedContext } from "@neta-art/cohub";
import { useFonts } from "expo-font";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import "react-native-reanimated";
import { AuthScreen } from "@/src/auth/AuthScreen";
import { AppUpdateBanner } from "@/src/components/AppUpdateBanner";
import { ToastProvider } from "@/src/components/Toast";
import { config, defaultEnvironment, resolveConfig, setActiveEnvironment, type CohubEnvironment } from "@/src/config";
import { AppProvider } from "@/src/data/context";
import { loadEnvironmentPreference, saveEnvironmentPreference } from "@/src/data/environment-preference";
import { LocaleProvider, useTranslation } from "@/src/i18n";
import { useAppTheme } from "@/src/theme";
import { NativeInteractionBridge } from "@/src/platform/NavigationBridge";
import { chatScrollTrace } from "@/src/data/chat-scroll-trace";
import { useDebugDiagnosticsLifecycle } from "@/src/data/debug-session";

export { ErrorBoundary } from "expo-router";

export const unstable_settings = {
  initialRouteName: "(tabs)",
};

SplashScreen.preventAutoHideAsync();

const logtoConfig = (environment: CohubEnvironment) => {
  const resolved = resolveConfig(environment);
  return {
    endpoint: resolved.authEndpoint,
    appId: resolved.logtoAppId,
    scopes: ["openid", "offline_access", "profile", "email"],
    resources: [resolved.apiResource],
  };
};

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 10_000, onTimeout?: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${label} timed out after ${timeoutMs / 1000} seconds`));
    }, timeoutMs);
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
  return <LocaleProvider><AuthEnvironmentRoot /></LocaleProvider>;
}

/** Resolves the sign-in environment before any request runs, then owns the Logto client for it. */
function AuthEnvironmentRoot() {
  const [environment, setEnvironment] = useState<CohubEnvironment | null>(null);

  useEffect(() => {
    let active = true;
    void loadEnvironmentPreference()
      .catch(() => null)
      .then((preference) => {
        if (!active) return;
        const selected = preference ?? defaultEnvironment;
        setActiveEnvironment(selected);
        setEnvironment(selected);
      });
    return () => {
      active = false;
    };
  }, []);

  const selectEnvironment = useCallback((next: CohubEnvironment) => {
    setActiveEnvironment(next);
    setEnvironment(next);
    void saveEnvironmentPreference(next).catch(() => undefined);
  }, []);

  const clientConfig = useMemo(() => environment ? logtoConfig(environment) : null, [environment]);
  if (!environment || !clientConfig) return <LoadingScreen />;

  // The provider swaps its Logto client when the config identity changes; remounting it
  // here would rebuild the login screen and flash a loading state on every switch.
  return (
    <LogtoProvider config={clientConfig}>
      <NativeRoot environment={environment} onSelectEnvironment={selectEnvironment} />
    </LogtoProvider>
  );
}

function NativeRoot({ environment, onSelectEnvironment }: { environment: CohubEnvironment; onSelectEnvironment: (environment: CohubEnvironment) => void }) {
  useDebugDiagnosticsLifecycle();
  const { client, isInitialized, isAuthenticated, signIn, signOut } = useLogto();
  const theme = useAppTheme();
  const [authLoading, setAuthLoading] = useState(false);
  const [authFailure, setAuthFailure] = useState<{ environment: CohubEnvironment; message: string } | null>(null);
  const [identity, setIdentity] = useState<{ authenticated: boolean; uuid: string | null }>(() => ({ authenticated: isAuthenticated, uuid: null }));
  const [identityAttempt, setIdentityAttempt] = useState(0);
  const authSessionVersionRef = useRef(0);
  const sessionRejectionHandledRef = useRef(false);
  const signOutRef = useRef(signOut);
  const environmentRef = useRef(environment);
  // A failure belongs to the environment it happened in, so switching drops it without an effect.
  const authError = authFailure?.environment === environment ? authFailure.message : null;

  useEffect(() => {
    signOutRef.current = signOut;
    environmentRef.current = environment;
  }, [environment, signOut]);

  // A new auth session invalidates 401s raised against the previous one. Clear the one-shot
  // guard only on a fresh sign-in, so signing out does not re-trigger behind the login screen.
  useEffect(() => {
    authSessionVersionRef.current += 1;
    if (isAuthenticated) sessionRejectionHandledRef.current = false;
  }, [environment, identity.uuid, isAuthenticated]);

  const rejectSession = useCallback((message: string) => {
    if (sessionRejectionHandledRef.current) return;
    sessionRejectionHandledRef.current = true;
    setAuthFailure({ environment: environmentRef.current, message });
    void Promise.resolve().then(() => signOutRef.current()).catch((error) => {
      console.warn("[mobile-auth] sign out after a rejected session failed", error);
    });
  }, []);

  const getAuthSessionVersion = useCallback(() => authSessionVersionRef.current, []);

  const onUnauthorized = useCallback((context: UnauthorizedContext) => {
    // A 401 from an auth session the app already replaced must not sign out the new one.
    if (context.authSessionVersion !== undefined && context.authSessionVersion !== authSessionVersionRef.current) return;
    rejectSession(translate("data.signInRejected"));
  }, [rejectSession]);

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
      if (!userUuid) throw new Error(translate("data.identityMissing"));
      if (active) {
        setAuthFailure(null);
        setIdentity({ authenticated: true, uuid: userUuid });
      }
    }).catch((error) => {
      if (active) {
        setAuthFailure({ environment, message: error instanceof Error ? error.message : "Unable to read your account" });
        setIdentity({ authenticated: true, uuid: null });
      }
    });
    return () => { active = false; };
  }, [client, environment, identityAttempt, isAuthenticated]);

  const getAccessToken = useCallback(async (options?: { forceRefresh?: boolean }) => {
    if (options?.forceRefresh) {
      try {
        await client.clearAccessToken();
      } catch (error) {
        console.warn("[mobile-auth] failed to clear the cached access token", error);
      }
    }
    let timedOut = false;
    try {
      return await withTimeout(client.getAccessToken(config.apiResource), "Loading sign-in token", 10_000, () => { timedOut = true; });
    } catch (error) {
      // Never report a dead refresh token as a generic request timeout. A slow auth endpoint
      // may recover on its own, but a rejected token needs the user to sign in again.
      console.warn("[mobile-auth] could not read an access token", error);
      if (!timedOut) rejectSession(translate("data.signInUnavailable"));
      return null;
    }
  }, [client, rejectSession]);

  const handleSignIn = useCallback(async () => {
    setAuthLoading(true);
    setAuthFailure(null);
    try {
      if (isAuthenticated) await signOut();
      await signIn(config.redirectUri);
      setIdentityAttempt((attempt) => attempt + 1);
    } catch (error) {
      setAuthFailure({ environment, message: error instanceof Error ? error.message : "Sign in was not completed" });
    } finally {
      setAuthLoading(false);
    }
  }, [environment, isAuthenticated, signIn, signOut]);

  useEffect(() => {
    if (isInitialized) void SplashScreen.hideAsync();
  }, [isInitialized]);

  if (!isInitialized) return <LoadingScreen />;
  if (!isAuthenticated || (authError && !identity.uuid)) return <AuthScreen environment={environment} onSelectEnvironment={onSelectEnvironment} onSignIn={handleSignIn} loading={authLoading} error={authError} />;
  if (identity.authenticated !== isAuthenticated || !identity.uuid) return <LoadingScreen />;
  return <AppProvider key={identity.uuid} userUuid={identity.uuid} getAccessToken={getAccessToken} getAuthSessionVersion={getAuthSessionVersion} onUnauthorized={onUnauthorized}><Navigation theme={theme} /></AppProvider>;
}

function Navigation({ theme }: { theme: ReturnType<typeof useAppTheme> }) {
  const { t } = useTranslation();
  // The authenticated navigation tree owns the lifetime of diagnostic recordings.
  useEffect(() => () => chatScrollTrace.reset(), []);
  const navigationTheme = theme.mode === "dark" ? DarkTheme : DefaultTheme;
  return <ThemeProvider value={{ ...navigationTheme, colors: { ...navigationTheme.colors, background: theme.colors.background, card: theme.colors.background, text: theme.colors.text, border: theme.colors.border, primary: theme.colors.accent } }}>
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <StatusBar style={theme.mode === "dark" ? "light" : "dark"} />
      <NativeInteractionBridge />
      <ToastProvider>
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
            <Stack.Screen name="new-chat" options={{ title: t("route.newChat"), presentation: "modal", animation: "slide_from_bottom" }} />
            <Stack.Screen name="settings" options={{ title: t("route.settings") }} />
            <Stack.Screen name="appearance" options={{ title: t("route.appearance") }} />
            <Stack.Screen name="language" options={{ title: t("route.language") }} />
            <Stack.Screen name="about" options={{ title: t("route.about") }} />
            <Stack.Screen name="debug/index" options={{ title: t("route.debug") }} />
            <Stack.Screen name="debug/chat-scroll" options={{ title: "Scroll Diagnostics" }} />
            <Stack.Screen name="debug/bubble-layout" options={{ title: "Bubble Layout" }} />
            <Stack.Screen name="debug/streaming" options={{ title: t("route.streaming") }} />
            <Stack.Screen name="debug/bubbles" options={{ title: t("route.bubbles") }} />
            <Stack.Screen name="debug/updates" options={{ title: t("route.updates") }} />
            <Stack.Screen name="debug/cache" options={{ title: t("route.cache") }} />
            <Stack.Screen name="debug/composer" options={{ title: t("route.composer") }} />
          <Stack.Screen name="debug/connection" options={{ title: t("route.connection") }} />
          <Stack.Screen name="debug/links" options={{ title: t("route.links") }} />
          <Stack.Screen name="debug/i18n" options={{ title: t("route.i18n") }} />
          <Stack.Screen name="debug/identity" options={{ title: t("route.identity") }} />
            <Stack.Screen name="debug/tools" options={{ title: t("route.tools") }} />
            <Stack.Screen name="debug/markdown" options={{ title: t("route.markdown") }} />
            <Stack.Screen name="debug/list" options={{ title: t("route.longList") }} />
          </Stack>
          <AppUpdateBanner />
        </View>
      </ToastProvider>
    </GestureHandlerRootView>
  </ThemeProvider>;
}

function LoadingScreen() {
  const theme = useAppTheme();
  return <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.background }}><ActivityIndicator size="small" color={theme.colors.accent} /></View>;
}
