/* eslint-disable react-hooks/immutability */
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { Keyboard, Pressable, Text, TextInput, View } from "react-native";
import Reanimated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
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
  damping: 20,
  stiffness: 300,
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
  const isExpanded = useSharedValue(0);
  const searchBarWidth = useSharedValue(0);
  const borderRadius = useSharedValue(999);

  const expand = useCallback(() => {
    isExpanded.value = withSpring(1, SPRING_CONFIG);
    borderRadius.value = withSpring(12, SPRING_CONFIG);
    setTimeout(() => inputRef.current?.focus(), 100);
  }, [isExpanded, borderRadius]);

  const collapse = useCallback(() => {
    isExpanded.value = withSpring(0, SPRING_CONFIG);
    borderRadius.value = withSpring(999, SPRING_CONFIG);
    Keyboard.dismiss();
    if (query) onQueryChange("");
  }, [isExpanded, borderRadius, query, onQueryChange]);

  useEffect(() => {
    if (queryRef && inputRef.current) {
      queryRef.current = inputRef.current;
    }
  }, [queryRef]);

  const searchBarStyle = useAnimatedStyle(() => ({
    width: isExpanded.value === 0 ? undefined : searchBarWidth.value,
    borderRadius: borderRadius.value,
  }));

  const leftIconStyle = useAnimatedStyle(() => ({
    opacity: isExpanded.value,
  }));

  const rightIconsStyle = useAnimatedStyle(() => ({
    opacity: 1 - isExpanded.value,
  }));

  const expanded = isExpanded.value > 0.5;

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
        searchBarWidth.value = e.nativeEvent.layout.width - 32;
      }}
    >
      {/* Left side: Menu or Back */}
      <Reanimated.View style={[{ position: expanded ? "absolute" : "relative", left: expanded ? 16 : undefined, zIndex: 2 }, leftIconStyle]}>
        {expanded && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close search"
            hitSlop={6}
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
            <AppIcon name="arrow-left" size={20} color={theme.colors.textSecondary} />
          </Pressable>
        )}
      </Reanimated.View>

      {!expanded && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Menu"
          hitSlop={6}
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
      )}

      {/* Search bar */}
      <Reanimated.View
        style={[
          {
            flex: expanded ? undefined : 1,
            height: 46,
            backgroundColor: theme.colors.surface,
            borderWidth: 1,
            borderColor: theme.colors.border,
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 14,
            gap: 10,
          },
          searchBarStyle,
        ]}
      >
        <AppIcon name="search" size={18} color={theme.colors.textMuted} />
        {expanded ? (
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
          />
        ) : (
          <Pressable
            style={{ flex: 1, height: 44, justifyContent: "center" }}
            onPress={expand}
            accessibilityRole="button"
            accessibilityLabel="Search"
          >
            <Text style={[typography.body, { color: theme.colors.textFaint }]}>{placeholder}</Text>
          </Pressable>
        )}
        {expanded && query.length > 0 && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            hitSlop={6}
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
      {!expanded && (
        <Reanimated.View style={[{ flexDirection: "row", alignItems: "center", gap: 8 }, rightIconsStyle]}>
          {account}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create new"
            hitSlop={6}
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
            hitSlop={6}
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
      )}
    </View>
  );
}
