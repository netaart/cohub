import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Image, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SettingsRow } from "@/src/components/SettingsRow";
import { useApp } from "@/src/data/context";
import { channelProviders, isChannelProvider, type ChannelProvider } from "@/src/data/channel-settings";
import { useNewChannel } from "@/src/data/use-new-channel";
import { useTranslation } from "@/src/i18n";
import { typography, useAppTheme } from "@/src/theme";
import { EmptyState, PrimaryButton, Screen, TopBar } from "@/src/ui";

const providerNames: Record<ChannelProvider, string> = { discord: "Discord", feishu: "Feishu / Lark", wechat: "WeChat", qq: "QQ Bot" };

export function NewChannelScreen() {
  const { provider } = useLocalSearchParams<{ provider?: string | string[] }>();
  const router = useRouter();
  const { t } = useTranslation();
  if (isChannelProvider(provider)) return <ChannelForm key={provider} provider={provider} />;
  return <Screen>
    <TopBar title={t("settings.channels.add")} onBack={() => router.back()} />
    {provider !== undefined ? <EmptyState icon="messages" title={t("route.notFound")} /> : <ScrollView>
      {channelProviders.map((value) => <SettingsRow key={value} icon="messages" title={providerNames[value]} onPress={() => router.push({ pathname: "/settings/new-channel", params: { provider: value } })} />)}
    </ScrollView>}
  </Screen>;
}

function ChannelForm({ provider }: { provider: ChannelProvider }) {
  const router = useRouter();
  const { client } = useApp();
  const { t } = useTranslation();
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const onCreated = useCallback(() => router.dismissTo("/settings/channels"), [router]);
  const { draft, setDraft, login, busy, error, submit, verify, cancelLogin } = useNewChannel(client, provider, onCreated);
  const [code, setCode] = useState("");
  const [qrError, setQrError] = useState(false);
  const inputStyle = [typography.body, { color: theme.colors.text, minHeight: 48, borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radius.sm, backgroundColor: theme.colors.surface, paddingHorizontal: theme.spacing.md }];
  const fields = ["name", ...(provider === "discord" ? ["token"] : provider === "feishu" || provider === "qq" ? ["appId", "secret"] : [])] as ("name" | "token" | "appId" | "secret")[];
  return <Screen keyboard>
    <TopBar title={providerNames[provider]} onBack={() => router.back()} />
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.lg, paddingBottom: insets.bottom + theme.spacing.xl }}>
      {fields.map((field) => <View key={field} style={{ gap: theme.spacing.sm }}>
        <Text style={[typography.caption, { color: theme.colors.textSecondary }]}>{t(`settings.channels.field.${field}`)}</Text>
        <TextInput
          accessibilityLabel={t(`settings.channels.field.${field}`)}
          value={draft[field]}
          onChangeText={(value) => setDraft((current) => ({ ...current, [field]: value }))}
          editable={!busy}
          secureTextEntry={field === "token" || field === "secret"}
          autoCorrect={false}
          autoCapitalize="none"
          style={inputStyle}
        />
      </View>)}
      {provider === "feishu" ? <View style={{ flexDirection: "row", borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radius.sm, overflow: "hidden" }}>
        {(["feishu", "lark"] as const).map((brand) => <Pressable key={brand} accessibilityRole="radio" accessibilityState={{ checked: draft.brand === brand, disabled: busy }} disabled={busy} onPress={() => setDraft((current) => ({ ...current, brand }))} style={({ pressed }) => ({ flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", backgroundColor: draft.brand === brand ? theme.colors.accentSoft : pressed ? theme.colors.surfacePressed : theme.colors.surface })}>
          <Text style={[typography.bodyMedium, { color: draft.brand === brand ? theme.colors.accent : theme.colors.text }]}>{brand === "feishu" ? "Feishu" : "Lark"}</Text>
        </Pressable>)}
      </View> : null}
      {login ? <View style={{ gap: theme.spacing.md, alignItems: "center" }}>
        {!login.expired ? <Image key={login.sessionKey} source={{ uri: login.qrDataUrl }} accessibilityLabel={t("settings.channels.qr")} resizeMode="contain" onError={() => setQrError(true)} onLoad={() => setQrError(false)} style={{ width: "100%", maxWidth: 280, aspectRatio: 1, backgroundColor: "#ffffff" }} /> : null}
        <Text accessibilityLiveRegion="polite" style={[typography.body, { color: theme.colors.textSecondary, textAlign: "center" }]}>{login.expired ? t("settings.channels.expired") : login.message}</Text>
        {qrError ? <Text accessibilityRole="alert" style={[typography.caption, { color: theme.colors.danger }]}>{t("settings.channels.qrError")}</Text> : null}
      </View> : null}
      {login?.needsCode ? <View style={{ gap: theme.spacing.md }}>
        <TextInput accessibilityLabel={t("settings.channels.code")} value={code} onChangeText={setCode} keyboardType="number-pad" autoCorrect={false} style={inputStyle} editable={!busy} />
        <PrimaryButton label={t("settings.channels.verify")} icon="check" loading={busy} onPress={() => verify(code)} />
      </View> : <PrimaryButton label={provider === "wechat" ? t(login ? "common.retry" : "settings.channels.connectWeChat") : t("common.create")} icon={provider === "wechat" ? "refresh" : "plus"} loading={busy} onPress={() => { setQrError(false); void submit(); }} />}
      {login ? <Pressable accessibilityRole="button" onPress={() => { setCode(""); setQrError(false); cancelLogin(); }} style={({ pressed }) => ({ minHeight: 44, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.6 : 1 })}>
        <Text style={[typography.bodyMedium, { color: theme.colors.textSecondary }]}>{t("common.cancel")}</Text>
      </Pressable> : null}
      {error ? <Text accessibilityRole="alert" style={[typography.body, { color: theme.colors.danger }]}>{error}</Text> : null}
    </ScrollView>
  </Screen>;
}
