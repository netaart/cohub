import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AdaptiveSheet } from "@/src/components/AdaptiveSheet";
import { SettingsRow } from "@/src/components/SettingsRow";
import { subscriptionCheckoutUrl } from "@/src/data/billing-settings";
import { useBillingHistory, type SubscriptionCancellation } from "@/src/data/use-billing-history";
import { useTranslation } from "@/src/i18n";
import { typography, useAppTheme } from "@/src/theme";
import { EmptyState, IconButton, PrimaryButton, Screen, TopBar } from "@/src/ui";

export function BillingHistoryScreen({ kind }: { kind: "history" | "subscriptions" }) {
  const router = useRouter();
  const { t } = useTranslation();
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { data, page, setPage, loading, saving, error, load, cancel } = useBillingHistory(kind);
  const [candidate, setCandidate] = useState<SubscriptionCancellation | null>(null);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [now] = useState(() => Date.now());
  const busy = loading || saving || paying;
  return <Screen>
    <TopBar title={t(kind === "history" ? "settings.billing.history" : "settings.billing.subscriptions")} onBack={() => router.back()} actions={<IconButton name="refresh" label={t("common.refresh")} disabled={busy} onPress={() => void load()} />} />
    <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + theme.spacing.xl }}>
      {loading ? <ActivityIndicator color={theme.colors.accent} style={{ padding: theme.spacing.xl }} /> : null}
      {error || paymentError ? <View style={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
        <Text accessibilityRole="alert" style={[typography.body, { color: theme.colors.danger }]}>{error || paymentError}</Text>
        <PrimaryButton label={t("common.retry")} icon="refresh" disabled={busy} onPress={() => { setPaymentError(null); void load(); }} />
      </View> : null}
      {!loading && data?.list.page === page ? <>
        {data.kind === "history" ? data.list.items.map((item) => <SettingsRow key={item.id} icon={item.amountUsd < 0 ? "arrow-up" : "arrow-down"} title={item.title} value={[new Date(item.createdAt).toLocaleString(), item.description, item.status].filter(Boolean).join(" · ")}>
          <Text style={[typography.caption, { color: item.amountUsd < 0 ? theme.colors.text : theme.colors.success, maxWidth: "35%" }]}>{item.amountUsd > 0 ? "+" : ""}${item.amountUsd.toFixed(2)}</Text>
        </SettingsRow>) : data.list.items.map((item) => <View key={item.id} style={{ padding: theme.spacing.lg, gap: theme.spacing.sm, borderBottomWidth: 1, borderBottomColor: theme.colors.border, backgroundColor: theme.colors.surface }}>
          <Text style={[typography.bodyMedium, { color: theme.colors.text }]}>{item.productName}</Text>
          <Text style={[typography.caption, { color: theme.colors.textSecondary }]}>{item.status} · ${item.amountUsd.toFixed(2)} · {item.billingPeriod}</Text>
          {item.currentPeriodStart || item.currentPeriodEnd ? <Text style={[typography.caption, { color: theme.colors.textMuted }]}>{[item.currentPeriodStart, item.currentPeriodEnd].filter(Boolean).map((date) => new Date(date!).toLocaleDateString()).join(" - ")}</Text> : null}
          {item.cancelAtPeriodEnd ? <Text style={[typography.caption, { color: theme.colors.textMuted }]}>{t("settings.billing.renewalCanceled")}</Text> : null}
          {item.checkoutExpiresAt && item.status === "pending_checkout" ? <Text style={[typography.caption, { color: theme.colors.textMuted }]}>{t("settings.billing.checkoutExpires", { date: new Date(item.checkoutExpiresAt).toLocaleString() })}</Text> : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.sm }}>
            {subscriptionCheckoutUrl(item, now) ? <PrimaryButton label={t("settings.billing.pay")} icon="external-link" disabled={busy} onPress={() => {
              const url = subscriptionCheckoutUrl(item, now);
              if (!url) { void load(); return; }
              setPaying(true);
              setPaymentError(null);
              void WebBrowser.openBrowserAsync(url).then(() => load()).catch((caught: unknown) => setPaymentError(caught instanceof Error ? caught.message : t("settings.billing.checkoutError"))).finally(() => setPaying(false));
            }} /> : null}
            {item.actions.canCancelCheckout || item.actions.canCancelAutoRenew ? <PrimaryButton label={t(item.actions.canCancelCheckout ? "settings.billing.cancelCheckout" : "settings.billing.cancelRenewal")} icon="x" tone="danger" disabled={busy} onPress={() => setCandidate({ subscription: item, kind: item.actions.canCancelCheckout ? "checkout" : "renewal" })} /> : null}
          </View>
        </View>)}
        {!data.list.items.length ? <EmptyState icon="database" title={t("settings.billing.noHistory")} /> : null}
      </> : null}
    </ScrollView>
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: theme.spacing.md, paddingBottom: insets.bottom }}>
      <IconButton name="arrow-left" label={t("settings.billing.previous")} disabled={busy || page <= 1} onPress={() => setPage(page - 1)} />
      <Text style={[typography.caption, { color: theme.colors.textMuted }]}>{page}</Text>
      <IconButton name="arrow-right" label={t("settings.billing.next")} disabled={busy || data?.list.page !== page || !data?.list.pagination.hasMore || data.list.pagination.nextPage === null} onPress={() => { const next = data?.list.pagination.nextPage; if (next) setPage(next); }} />
    </View>
    <AdaptiveSheet visible={candidate !== null} title={t(candidate?.kind === "checkout" ? "settings.billing.cancelCheckout" : "settings.billing.cancelRenewal")} subtitle={candidate?.subscription.productName} onClose={() => { if (!saving) setCandidate(null); }} dismissible={!saving} scrollable={false} footer={<PrimaryButton label={t("common.confirm")} icon="check" tone="danger" loading={saving} onPress={() => { if (candidate) void cancel(candidate).then((ok) => { if (ok) setCandidate(null); }); }} />}>
      <Text style={[typography.body, { color: theme.colors.text }]}>{t(candidate?.kind === "checkout" ? "settings.billing.cancelCheckoutConfirm" : "settings.billing.cancelRenewalConfirm")}</Text>
      {error ? <Text accessibilityRole="alert" style={[typography.caption, { color: theme.colors.danger, marginTop: theme.spacing.md }]}>{error}</Text> : null}
    </AdaptiveSheet>
  </Screen>;
}
