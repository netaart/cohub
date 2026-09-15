import { LinearGradient } from "expo-linear-gradient";
import { useState, type ReactNode } from "react";
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { collapsedComposerHeight } from "@/src/ui/composer-layout";
import { edgeChrome, useAppTheme } from "@/src/theme";

export function useEdgeChrome(options?: { reserveComposer?: boolean }) {
  const insets = useSafeAreaInsets();
  const [headerHeight, setHeaderHeight] = useState(insets.top + edgeChrome.headerMinHeight);
  const [footerHeight, setFooterHeight] = useState(() => options?.reserveComposer ? collapsedComposerHeight(insets.bottom) : 0);
  return {
    headerHeight,
    footerHeight,
    onHeaderLayout: (event: LayoutChangeEvent) => setHeaderHeight(event.nativeEvent.layout.height),
    onFooterLayout: (event: LayoutChangeEvent) => setFooterHeight(event.nativeEvent.layout.height),
  };
}

export function EdgeScrim({ edge, style }: { edge: "top" | "bottom"; style?: StyleProp<ViewStyle> }) {
  const { colors } = useAppTheme();
  return <LinearGradient
    pointerEvents="none"
    accessible={false}
    colors={[colors.background, `${colors.background}f5`, `${colors.background}b8`, `${colors.background}00`]}
    locations={[0, 0.45, 0.75, 1]}
    start={{ x: 0, y: edge === "top" ? 0 : 1 }}
    end={{ x: 0, y: edge === "top" ? 1 : 0 }}
    style={[StyleSheet.absoluteFill, style]}
  />;
}

export function EdgeHeader({ children, onLayout }: { children: ReactNode; onLayout: (event: LayoutChangeEvent) => void }) {
  const insets = useSafeAreaInsets();
  return <View pointerEvents="box-none" onLayout={onLayout} style={[styles.header, { paddingTop: insets.top }]}>
    <EdgeScrim edge="top" style={{ bottom: -edgeChrome.fade }} />
    {children}
  </View>;
}

export function EdgeFooter({ children, onLayout }: { children: ReactNode; onLayout: (event: LayoutChangeEvent) => void }) {
  return <View pointerEvents="box-none" onLayout={onLayout} style={styles.footer}>
    <EdgeScrim edge="bottom" style={{ top: -edgeChrome.fade }} />
    {children}
  </View>;
}

const styles = StyleSheet.create({
  header: { position: "absolute", top: 0, left: 0, right: 0, zIndex: 1 },
  footer: { position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 1 },
});
