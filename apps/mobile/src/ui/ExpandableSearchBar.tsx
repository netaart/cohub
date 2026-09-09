/* eslint-disable react-hooks/immutability */
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { Keyboard, Pressable, TextInput, View } from "react-native";
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  useDerivedValue,
  interpolate,
  runOnJS,
} from "react-native-reanimated";
import { AppIcon } from "@/src/ui";
import { useAppTheme, typography } from "@/src/theme";

type ExpandableSearchBarProps = {
  query: string;
  onQueryChange: (value: string) => void;
  placeholder?: string;
  queryRef?: React.RefObject<TextInput | null>;
  account: ReactNode;
  onMenuPress: () => void;
  onSettingsPress: () => void;
  onCreate: () => void;
};

const SPRING_CONFIG = {
  damping: 25,
  stiffness: 400,
};

export function ExpandableSearchBar({
  query,
  onQueryChange,
  placeholder = "Search",
  queryRef,
  account,
  onMenuPress,
  onSettingsPress,
  onCreate,
}: ExpandableSearchBarProps) {
  const theme = useAppTheme();
  const inputRef = useRef<TextInput>(null);
  const progress = useSharedValue(0); // 0 = collapsed, 1 = expanded
  const containerWidth = useSharedValue(300);

  const focusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  const expand = useCallback(() => {
    progress.value = withSpring(1, SPRING_CONFIG, () => {
      runOnJS(focusInput)();
    });
  }, [progress, focusInput]);

  const collapse = useCallback(() => {
    progress.value = withSpring(0, SPRING_CONFIG);
    Keyboard.dismiss();
    if (query) onQueryChange("");
  }, [progress, query, onQueryChange]);

  useEffect(() => {
    if (queryRef && inputRef.current) {
      queryRef.current = inputRef.current;
    }
  }, [queryRef]);

  const searchBarStyle = useAnimatedStyle(() => {
    const width = interpolate(
      progress.value,
      [0, 1],
      [containerWidth.value * 0.6, containerWidth.value - 32]
    );
    const radius = interpolate(progress.value, [0, 1], [999, 12]);
    return {
      width,
      borderRadius: radius,
    };
  });

  const leftButtonStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: progress.value }],
  }));

  const rightGroupStyle = useAnimatedStyle(() => ({
    opacity: 1 - progress.value,
    transform: [{ scale: 1 - progress.value * 0.3 }],
  }));

  const isExpanded = useDerivedValue(() => progress.value > 0.5);

  return (
    <View
      style={{
        minHeight: 66,
        paddingHorizontal: 16,
        paddingVertical: 10,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
      onLayout={(e) => {
        containerWidth.value = e.nativeEvent.layout.width;
      }}
    >
      {/* Back button - overlays when expanded */}
      <Reanimated.View
        style={[
          {
            position: "absolute",
            left: 16,
            zIndex: 10,
          },
          leftButtonStyle,
        ]}
        pointerEvents={isExpanded.value ? "auto" : "none"}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close search"
          hitSlop={8}
          onPress={collapse}
          style={({ pressed }) => ({
            width: 42,
            height: 42,
            borderRadius: 21,
            backgroundColor: pressed ? theme.colors.surfacePressed : "transparent",
            alignItems: "center",
            justifyContent: "center",
          })}
        >
          <AppIcon name="arrow-left" size={20} color={theme.colors.text} />
        </Pressable>
      </Reanimated.View>

      {/* Menu button */}
      <Reanimated.View style={rightGroupStyle} pointerEvents={isExpanded.value ? "none" : "auto"}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Menu"
          hitSlop={8}
          onPress={onMenuPress}
          style={({ pressed }) => ({
            width: 42,
            height: 42,
            borderRadius: 21,
            backgroundColor: pressed ? theme.colors.surfacePressed : "transparent",
            alignItems: "center",
            justifyContent: "center",
          })}
        >
          <AppIcon name="more" size={20} color={theme.colors.textSecondary} />
        </Pressable>
      </Reanimated.View>

      {/* Search bar capsule */}
      <Reanimated.View
        style={[
          {
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
          placeholder={placeholder}
          placeholderTextColor={theme.colors.textFaint}
          style={[
            typography.body,
            {
              flex: 1,
              height: 44,
              color: theme.colors.text,
              padding: 0,
            },
          ]}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
          onFocus={expand}
        />
        {query.length > 0 && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear search"
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
        )}
      </Reanimated.View>

      {/* Right side: Avatar, Plus, Settings */}
      <Reanimated.View
        style={[{ flexDirection: "row", alignItems: "center", gap: 8 }, rightGroupStyle]}
        pointerEvents={isExpanded.value ? "none" : "auto"}
      >
        {account}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Create new"
          hitSlop={8}
          onPress={onCreate}
          style={({ pressed }) => ({
            width: 42,
            height: 42,
            borderRadius: 21,
            backgroundColor: pressed ? theme.colors.accentSoft : "transparent",
            alignItems: "center",
            justifyContent: "center",
          })}
        >
          <AppIcon name="plus" size={20} color={theme.colors.accent} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Settings"
          hitSlop={8}
          onPress={onSettingsPress}
          style={({ pressed }) => ({
            width: 42,
            height: 42,
            borderRadius: 21,
            backgroundColor: pressed ? theme.colors.surfacePressed : "transparent",
            alignItems: "center",
            justifyContent: "center",
          })}
        >
          <AppIcon name="settings" size={20} color={theme.colors.textSecondary} />
        </Pressable>
      </Reanimated.View>
    </View>
  );
}
