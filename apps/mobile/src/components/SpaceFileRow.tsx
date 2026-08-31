import type { SpaceFsEntry } from "@neta-art/cohub";
import { Pressable, Text, View } from "react-native";
import { AppIcon, type IconName } from "@/src/ui";
import { useAppTheme, typography } from "@/src/theme";
import { formatRelativeTime } from "@/src/utils";

type SpaceFileRowProps = {
  entry: SpaceFsEntry;
  onPress: () => void;
  compact?: boolean;
};

export function formatSpaceFileBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function SpaceFileRow({ entry, onPress, compact = false }: SpaceFileRowProps) {
  const theme = useAppTheme();
  const isDirectory = entry.type === "dir";
  const isSymlink = entry.type === "symlink";
  const icon: IconName = isDirectory ? "folder" : isSymlink ? "external-link" : "file-text";
  const iconColor = isDirectory ? theme.colors.accent : theme.colors.textMuted;
  const detail = isDirectory
    ? "Folder"
    : isSymlink
      ? "Symbolic link"
      : `${entry.mimeType || "File"} · ${formatSpaceFileBytes(entry.size)}`;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${isDirectory ? "Open folder" : "Open file"} ${entry.name}`}
      onPress={onPress}
      android_ripple={{ color: theme.colors.pressOverlay }}
      style={({ pressed }) => ({
        minHeight: compact ? 60 : 63,
        flexDirection: "row",
        alignItems: "center",
        gap: compact ? 10 : 11,
        paddingHorizontal: compact ? 14 : 16,
        backgroundColor: pressed ? theme.colors.surfacePressed : "transparent",
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      })}
    >
      <View style={{ width: compact ? 33 : 34, height: compact ? 33 : 34, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: isDirectory ? theme.colors.accentSoft : theme.colors.surface }}>
        <AppIcon name={icon} size={17} color={iconColor} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={[typography.bodyMedium, { color: theme.colors.text }]}>{entry.name}</Text>
        <Text numberOfLines={1} style={[typography.micro, { color: theme.colors.textMuted, marginTop: compact ? 2 : 3 }]}>{detail}</Text>
      </View>
      {!compact ? <Text style={[typography.micro, { color: theme.colors.textFaint }]}>{entry.mtimeMs ? formatRelativeTime(new Date(entry.mtimeMs).toISOString()) : ""}</Text> : null}
      <AppIcon name="chevron-right" size={compact ? 15 : 16} color={theme.colors.textFaint} />
    </Pressable>
  );
}
