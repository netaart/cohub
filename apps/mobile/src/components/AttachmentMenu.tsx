import type { RefObject } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ComposerMenu } from "@/src/components/ComposerMenu";
import { useTranslation } from "@/src/i18n";
import { typography, useAppTheme } from "@/src/theme";
import { AppIcon, type IconName } from "@/src/ui";

export function AttachmentMenu({ anchorRef, onClose, onCamera, onPhotos, onFile }: {
  anchorRef: RefObject<View | null>;
  onClose: () => void;
  onCamera: () => void;
  onPhotos: () => void;
  onFile: () => void;
}) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const actions: { icon: IconName; label: string; onPress: () => void }[] = [
    { icon: "camera", label: t("chat.attachment.camera"), onPress: onCamera },
    { icon: "images", label: t("chat.attachment.photos"), onPress: onPhotos },
    { icon: "paperclip", label: t("chat.attachment.file"), onPress: onFile },
  ];
  return <ComposerMenu anchorRef={anchorRef} title={t("chat.attachment.title")} onClose={onClose} preferredWidth={240} testID="chat-attachment-menu">
    <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {actions.map((action) => <Pressable key={action.icon} accessibilityRole="button" accessibilityLabel={action.label} onPress={action.onPress} style={({ pressed }) => [styles.action, { backgroundColor: pressed ? theme.colors.surfacePressed : "transparent" }]}>
        <AppIcon name={action.icon} size={22} color={theme.colors.textSecondary} />
        <Text style={[typography.body, { color: theme.colors.text, flex: 1 }]}>{action.label}</Text>
      </Pressable>)}
    </ScrollView>
  </ComposerMenu>;
}

const styles = StyleSheet.create({
  content: { padding: 6 },
  action: { minHeight: 52, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 8, flexDirection: "row", alignItems: "center", gap: 14 },
});
