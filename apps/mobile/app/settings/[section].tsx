import { useLocalSearchParams, useRouter } from "expo-router";
import { SettingsScreen } from "@/src/components/SettingsScreen";
import { isSettingsSection } from "@/src/data/settings-navigation";
import { useTranslation } from "@/src/i18n";
import { EmptyState, Screen, TopBar } from "@/src/ui";

export default function SettingsSectionRoute() {
  const { section } = useLocalSearchParams<{ section?: string | string[] }>();
  const router = useRouter();
  const { t } = useTranslation();
  if (!isSettingsSection(section)) return <Screen>
    <TopBar title={t("settings.title")} onBack={() => router.back()} />
    <EmptyState icon="settings" title={t("route.notFound")} action={{ icon: "arrow-left", label: t("settings.title"), onPress: () => router.replace("/settings") }} />
  </Screen>;
  return <SettingsScreen key={section} section={section} />;
}
