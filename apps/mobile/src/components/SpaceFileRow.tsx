import type { SpaceFsEntry } from "@neta-art/cohub";
import type { LucideIcon } from "lucide-react-native";
import Braces from "lucide-react-native/icons/braces";
import Database from "lucide-react-native/icons/database";
import FileArchive from "lucide-react-native/icons/file-archive";
import FileCode from "lucide-react-native/icons/file-code";
import FileImage from "lucide-react-native/icons/file-image";
import FileSpreadsheet from "lucide-react-native/icons/file-spreadsheet";
import FileText from "lucide-react-native/icons/file-text";
import Music from "lucide-react-native/icons/music";
import Video from "lucide-react-native/icons/video";
import { Pressable, Text, View } from "react-native";
import { AppIcon, type IconName } from "@/src/ui";
import { useAppTheme, typography } from "@/src/theme";
import { formatRelativeTime } from "@/src/utils";

type SpaceFileRowProps = {
  entry: SpaceFsEntry;
  onPress: () => void;
  compact?: boolean;
};

const FILE_TYPE_ICONS: { extensions: string[]; icon: LucideIcon; color: string }[] = [
  { extensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "rs", "go", "java", "kt", "swift", "c", "cpp", "h", "cs", "php", "lua", "sh", "bash", "zsh", "html", "css", "scss", "vue", "svelte"], icon: FileCode, color: "#6366f1" },
  { extensions: ["json", "jsonc", "yml", "yaml", "toml", "ini", "env", "cfg", "conf"], icon: Braces, color: "#f59e0b" },
  { extensions: ["csv", "tsv", "xls", "xlsx"], icon: FileSpreadsheet, color: "#16a34a" },
  { extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "heic"], icon: FileImage, color: "#ec4899" },
  { extensions: ["mp3", "wav", "aac", "ogg", "flac", "m4a", "opus"], icon: Music, color: "#a855f7" },
  { extensions: ["mp4", "mov", "webm", "avi", "mkv", "m4v"], icon: Video, color: "#ef4444" },
  { extensions: ["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"], icon: FileArchive, color: "#0891b2" },
  { extensions: ["sqlite", "db", "sql"], icon: Database, color: "#0284c7" },
];

function fileTypeIcon(name: string): { icon: LucideIcon; color: string } {
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const match = FILE_TYPE_ICONS.find((type) => type.extensions.includes(extension));
  return { icon: match?.icon ?? FileText, color: match?.color ?? "#8b8b8b" };
}

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
  const fileType = isDirectory || isSymlink ? null : fileTypeIcon(entry.name);
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
      <View style={{ width: compact ? 33 : 34, height: compact ? 33 : 34, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: fileType ? `${fileType.color}1f` : isDirectory ? theme.colors.accentSoft : theme.colors.surface }}>
        {fileType ? <fileType.icon size={17} color={fileType.color} /> : <AppIcon name={icon} size={17} color={iconColor} />}
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
