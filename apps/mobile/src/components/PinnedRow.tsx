import type { ReactNode } from "react";
import { Pressable, View, type ViewStyle } from "react-native";
import { useAppTheme } from "@/src/theme";
import { IconButton } from "@/src/ui";

type PinnedRowProps = {
  children: ReactNode;
  openLabel: string;
  pinLabel: string;
  unpinLabel: string;
  pinned: boolean;
  pinning: boolean;
  onPress: () => void;
  onTogglePin: () => void;
  rowStyle: (state: { pressed: boolean }) => ViewStyle;
};

export function PinnedRow({
  children,
  openLabel,
  pinLabel,
  unpinLabel,
  pinned,
  pinning,
  onPress,
  onTogglePin,
  rowStyle,
}: PinnedRowProps) {
  const theme = useAppTheme();
  return (
    <View style={[styles.shell, { borderBottomColor: theme.colors.border }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={openLabel}
        onPress={onPress}
        android_ripple={{ color: theme.colors.pressOverlay }}
        style={({ pressed }) => [rowStyle({ pressed }), styles.primary]}
      >
        {children}
      </Pressable>
      <View style={styles.pinAction}>
        <IconButton
          name={pinned ? "pin-off" : "pin"}
          label={pinned ? unpinLabel : pinLabel}
          size={36}
          tone={pinned ? "accent" : "default"}
          disabled={pinning}
          onPress={() => onTogglePin()}
        />
      </View>
    </View>
  );
}

const styles = {
  shell: {
    flexDirection: "row" as const,
    alignItems: "stretch" as const,
    borderBottomWidth: 1,
  },
  primary: {
    flex: 1,
    borderBottomWidth: 0,
    paddingRight: 4,
  },
  pinAction: {
    justifyContent: "center" as const,
    paddingRight: 8,
  },
} satisfies Record<string, object>;
