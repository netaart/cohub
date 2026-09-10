/* eslint-disable react-hooks/immutability */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Keyboard, Pressable, TextInput, View } from "react-native";
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  interpolate,
} from "react-native-reanimated"
import { AppIcon } from "@/src/ui";
import { useTranslation } from "@/src/i18n";
import { useAppTheme, typography } from "@/src/theme";

type ExpandableSearchBarProps = {
  query: string;
  onQueryChange: (value: string) => void;
  placeholder?: string;
  queryRef?: React.RefObject<TextInput | null>;
  account: ReactNode;
  onCreate: () => void;
};

const EXPAND_DURATION = 180;

const BUTTON_SIZE = 42;
const GAP = 8;

export function ExpandableSearchBar({
  query,
  onQueryChange,
  placeholder,
  queryRef,
  account,
  onCreate,
}: ExpandableSearchBarProps) {
  const theme = useAppTheme();
  const { t } = useTranslation();
  const inputRef = useRef<TextInput>(null);
  const expandedRef = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const progress = useSharedValue(0);

  const expand = useCallback(() => {
    if (expandedRef.current) return;
    expandedRef.current = true;
    setExpanded(true);
    progress.value = withTiming(1, { duration: EXPAND_DURATION });
  }, [progress]);

  const collapse = useCallback(() => {
    if (!expandedRef.current) return;
    expandedRef.current = false;
    setExpanded(false);
    progress.value = withTiming(0, { duration: EXPAND_DURATION });
    Keyboard.dismiss();
    if (query) onQueryChange("");
  }, [progress, query, onQueryChange]);

  useEffect(() => {
    if (queryRef && inputRef.current) {
      queryRef.current = inputRef.current;
    }
  }, [queryRef]);

  // Left button: back (expanded) or menu (collapsed) — same slot
  const leftSlotStyle = useAnimatedStyle(() => ({
    width: BUTTON_SIZE,
  }));

  const backButtonStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: interpolate(progress.value, [0, 1], [0.6, 1]) }],
  }));

  // Search capsule: border radius animates, width via flex
  const searchBarStyle = useAnimatedStyle(() => ({
    borderRadius: interpolate(progress.value, [0, 1], [999, 14]),
  }));

  // Right group: collapse width to 0 when expanded
  const rightGroupStyle = useAnimatedStyle(() => {
    const fullWidth = BUTTON_SIZE;
    return {
      width: interpolate(progress.value, [0, 1], [fullWidth, 0]),
      marginLeft: interpolate(progress.value, [0, 1], [GAP, 0]),
      opacity: interpolate(progress.value, [0, 0.4], [1, 0]),
      overflow: "hidden" as const,
    };
  });

  return (
    <View
      style={{
        minHeight: 66,
        paddingHorizontal: 16,
        paddingVertical: 10,
        flexDirection: "row",
        alignItems: "center",
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
   }}
    >
      {/* Left slot: back when searching, avatar otherwise */}
      <Reanimated.View style={[{ height: BUTTON_SIZE, marginRight: GAP }, leftSlotStyle]}>
        <Reanimated.View
     style={[{ position: "absolute", top: 0, left: 0 }, backButtonStyle]}
        pointerEvents={expanded ? "auto" : "none"}
        >
          <Pressable
            accessibilityRole="button"
         accessibilityLabel={t("ui.search.close")}
            hitSlop={8}
            onPress={collapse}
            style={({ pressed }) => ({
     width: BUTTON_SIZE,
              height: BUTTON_SIZE,
    borderRadius: BUTTON_SIZE / 2,
              backgroundColor: pressed ? theme.colors.surfacePressed : "transparent",
   alignItems: "center",
     justifyContent: "center",
            })}
      >
   <AppIcon name="arrow-left" size={20} color={theme.colors.text} />
          </Pressable>
        </Reanimated.View>
        <Reanimated.View
          style={[{ position: "absolute", top: 0, left: 0, height: BUTTON_SIZE, justifyContent: "center" }, { opacity: expanded ? 0 : 1 }]}
          pointerEvents={expanded ? "none" : "auto"}
        >
          {account}
        </Reanimated.View>
      </Reanimated.View>

    {/* Search capsule: flex: 1 fills whatever the right group releases */}
      <Reanimated.View
        style={[
    {
  flex: 1,
            minWidth: 0,
            height: 46,
        backgroundColor: theme.colors.surface,
            borderWidth: 1,
  borderColor: theme.colors.border,
        flexDirection: "row",
alignItems: "center",
            paddingHorizontal: 14,
      gap: 10,
            overflow: "hidden",
   },
          searchBarStyle,
        ]}
      >
 <AppIcon name="search" size={18} color={theme.colors.textMuted} />
        <TextInput
 ref={inputRef}
     value={query}
          onChangeText={onQueryChange}
      placeholder={placeholder ?? t("ui.search.placeholder")}
    placeholderTextColor={theme.colors.textFaint}
 style={[typography.body, { flex: 1, minWidth: 0, height: 44, color: theme.colors.text, padding: 0 }]}
          returnKeyType="search"
          autoCapitalize="none"
  autoCorrect={false}
onFocus={expand}
        />
  {query.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("ui.search.clear")}
            hitSlop={8}
            onPress={() => onQueryChange("")}
        style={({ pressed }) => ({
      width: 28,
              height: 28,
      borderRadius: 14,
            backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceRaised,
              alignItems: "center",
              justifyContent: "center",
        })}
          >
   <AppIcon name="x" size={14} color={theme.colors.textSecondary} />
       </Pressable>
        ) : null}
</Reanimated.View>

      {/* Right group: shrinks to width 0 when expanded */}
      <Reanimated.View
        style={[{ flexDirection: "row", alignItems: "center", gap: GAP }, rightGroupStyle]}
        pointerEvents={expanded ? "none" : "auto"}
      >
        <Pressable
          accessibilityRole="button"
       accessibilityLabel={t("ui.createNew")}
          hitSlop={8}
          onPress={onCreate}
          style={({ pressed }) => ({
        width: BUTTON_SIZE,
            height: BUTTON_SIZE,
   borderRadius: BUTTON_SIZE / 2,
         backgroundColor: pressed ? theme.colors.accentSoft : "transparent",
            alignItems: "center",
            justifyContent: "center",
          })}
        >
          <AppIcon name="plus" size={20} color={theme.colors.accent} />
  </Pressable>
      </Reanimated.View>
    </View>
  );
}
