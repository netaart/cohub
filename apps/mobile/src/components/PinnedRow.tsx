import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { useAppTheme } from "@/src/theme";
import { IconButton } from "@/src/ui";
import { PressableScale } from "@/src/ui/PressableScale";

type PinnedRowProps = {
  children: ReactNode;
  openLabel: string;
  pinLabel: string;
  unpinLabel: string;
  pinned: boolean;
  pinning: boolean;
  onPress: () => void;
  onTogglePin: () => void;
  rowStyle: ViewStyle;
  rowPressedStyle?: StyleProp<ViewStyle>;
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
  rowPressedStyle,
}: PinnedRowProps) {
  const theme = useAppTheme();
  return (
    <View style={[styles.shell, { borderBottomColor: theme.colors.border }]}>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={openLabel}
        onPress={onPress}
        haptic
        style={[rowStyle, styles.primary]}
        pressedStyle={rowPressedStyle}
      >
        {children}
      </PressableScale>
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
