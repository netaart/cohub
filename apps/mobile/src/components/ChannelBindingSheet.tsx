import type { Channel } from "@neta-art/cohub";
import { ActivityIndicator, Text, View } from "react-native";
import { AdaptiveSheet } from "@/src/components/AdaptiveSheet";
import { SettingsRow } from "@/src/components/SettingsRow";
import { useApp } from "@/src/data/context";
import { useChannelBinding } from "@/src/data/use-channel-binding";
import { useTranslation } from "@/src/i18n";
import { typography, useAppTheme } from "@/src/theme";
import { EmptyState, PrimaryButton } from "@/src/ui";

export function ChannelBindingSheet({ channel, onClose, onChanged }: { channel: Channel; onClose: () => void; onChanged: () => void }) {
  const { client } = useApp();
  const { t } = useTranslation();
  const theme = useAppTheme();
  const { spaces, loading, saving, error, load, save } = useChannelBinding(client, channel, onChanged);
  return <AdaptiveSheet
    visible
    title={t(channel.boundSpace ? "settings.channels.unbind" : "settings.channels.bind")}
    subtitle={channel.name}
    onClose={onClose}
    dismissible={!saving}
    footer={channel.boundSpace ? <PrimaryButton label={t("settings.channels.unbind")} icon="x" tone="danger" loading={saving} onPress={() => void save(channel.boundSpace!.id)} /> : undefined}
  >
    {channel.boundSpace ? <Text style={[typography.body, { color: theme.colors.text }]}>{t("settings.channels.unbindConfirm")}</Text> : loading ? <ActivityIndicator color={theme.colors.accent} /> : <View>
      {spaces.map((space) => <SettingsRow key={space.id} icon="layers" title={space.name || space.id} disabled={saving} onPress={() => void save(space.id)} />)}
      {!spaces.length && !error ? <EmptyState icon="layers" title={t("settings.channels.noSpaces")} /> : null}
    </View>}
    {error ? <View style={{ gap: theme.spacing.md }}>
      <Text accessibilityRole="alert" style={[typography.body, { color: theme.colors.danger }]}>{error}</Text>
      {!channel.boundSpace ? <PrimaryButton label={t("common.retry")} icon="refresh" disabled={saving} onPress={() => void load()} /> : null}
    </View> : null}
  </AdaptiveSheet>;
}
