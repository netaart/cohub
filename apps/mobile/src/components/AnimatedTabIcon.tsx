import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "expo-router";
import { Animated, Easing, Platform, StyleSheet, View, type ColorValue } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";

export type AnimatedTabIconName = "messages" | "layers" | "activity" | "user";

type AnimatedTabIconProps = {
  name: AnimatedTabIconName;
  color: ColorValue;
  size: number;
  focused: boolean;
  route: "/" | "/spaces" | "/activity" | "/profile";
};

export function AnimatedTabIcon({ name, color, size, focused, route }: AnimatedTabIconProps) {
  const pathname = usePathname();
  const selected = pathname === route || (route === "/" && pathname === "/(tabs)");
  switch (name) {
    case "messages":
      return <MessagesGlyph color={color} size={size} focused={focused} selected={selected} />;
    case "layers":
      return <LayersGlyph color={color} size={size} focused={focused} selected={selected} />;
    case "activity":
      return <ActivityGlyph color={color} size={size} focused={focused} selected={selected} />;
    case "user":
      return <UserGlyph color={color} size={size} focused={focused} selected={selected} />;
  }
}

function useTabProgress(focused: boolean, duration: number) {
  const [progress] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const animation = Animated.timing(progress, {
      toValue: focused ? 1 : 0,
      duration: focused ? duration : 260,
      easing: focused ? Easing.out(Easing.cubic) : Easing.inOut(Easing.cubic),
      useNativeDriver: Platform.OS !== "web",
    });
    animation.start();
    return () => animation.stop();
  }, [duration, focused, progress]);
  return progress;
}

function IconFrame({ size, children }: { size: number; children: ReactNode }) {
  return <View style={{ width: size, height: size }}>{children}</View>;
}

function SvgLayer({ size, children, style }: { size: number; children: ReactNode; style: object }) {
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        {children}
      </Svg>
    </Animated.View>
  );
}

function StrokePath({ color, d, width = 1.8 }: { color: ColorValue; d: string; width?: number }) {
  return <Path d={d} stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />;
}

function MessagesGlyph({ color, size, focused, selected }: Omit<AnimatedTabIconProps, "name" | "route"> & { selected: boolean }) {
  const progress = useTabProgress(selected, 430);
  const backStyle = {
    opacity: progress.interpolate({ inputRange: [0, 0.16, 0.38, 0.56, 0.76, 1], outputRange: [1, 1, 0.82, 0.95, 1, 1], extrapolate: "clamp" }),
    transform: [
      { translateX: progress.interpolate({ inputRange: [0, 0.16, 0.38, 0.56, 0.76, 1], outputRange: [0, 0, -3.2, -0.7, 0, 0], extrapolate: "clamp" }) },
      { translateY: progress.interpolate({ inputRange: [0, 0.16, 0.38, 0.56, 0.76, 1], outputRange: [0, 0, 1.8, 0.4, 0, 0], extrapolate: "clamp" }) },
      { rotate: progress.interpolate({ inputRange: [0, 0.16, 0.38, 0.56, 0.76, 1], outputRange: ["0deg", "0deg", "-5deg", "-1deg", "0deg", "0deg"], extrapolate: "clamp" }) },
      { scaleX: progress.interpolate({ inputRange: [0, 0.16, 0.38, 0.56, 0.76, 1], outputRange: [1, 1, 0.84, 0.96, 1, 1], extrapolate: "clamp" }) },
      { scaleY: progress.interpolate({ inputRange: [0, 0.16, 0.38, 0.56, 0.76, 1], outputRange: [1, 1, 0.9, 0.98, 1, 1], extrapolate: "clamp" }) },
    ],
  };
  const frontStyle = {
    opacity: progress.interpolate({ inputRange: [0, 0.28, 0.5, 0.7, 0.88, 1], outputRange: [1, 1, 0.84, 0.96, 1, 1], extrapolate: "clamp" }),
    transform: [
      { translateX: progress.interpolate({ inputRange: [0, 0.28, 0.5, 0.7, 0.88, 1], outputRange: [0, 0, 3.2, 0.6, 0, 0], extrapolate: "clamp" }) },
      { translateY: progress.interpolate({ inputRange: [0, 0.28, 0.5, 0.7, 0.88, 1], outputRange: [0, 0, -1.8, -0.35, 0, 0], extrapolate: "clamp" }) },
      { rotate: progress.interpolate({ inputRange: [0, 0.28, 0.5, 0.7, 0.88, 1], outputRange: ["0deg", "0deg", "5deg", "1deg", "0deg", "0deg"], extrapolate: "clamp" }) },
      { scaleX: progress.interpolate({ inputRange: [0, 0.28, 0.5, 0.7, 0.88, 1], outputRange: [1, 1, 0.84, 0.96, 1, 1], extrapolate: "clamp" }) },
      { scaleY: progress.interpolate({ inputRange: [0, 0.28, 0.5, 0.7, 0.88, 1], outputRange: [1, 1, 0.9, 0.98, 1, 1], extrapolate: "clamp" }) },
    ],
  };
  return (
    <IconFrame size={size}>
      <SvgLayer size={size} style={backStyle}>
        <StrokePath color={color} width={focused ? 2.05 : 1.8} d="M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
      </SvgLayer>
      <SvgLayer size={size} style={frontStyle}>
        <StrokePath color={color} width={focused ? 2.05 : 1.8} d="M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1" />
      </SvgLayer>
    </IconFrame>
  );
}

function LayersGlyph({ color, size, focused, selected }: Omit<AnimatedTabIconProps, "name" | "route"> & { selected: boolean }) {
  const progress = useTabProgress(selected, 460);
  const upperStyle = {
    transform: [
      { translateY: progress.interpolate({ inputRange: [0, 0.14, 0.36, 0.54, 0.76, 1], outputRange: [0, 0, -3.2, -0.65, 0, 0], extrapolate: "clamp" }) },
      { rotate: progress.interpolate({ inputRange: [0, 0.14, 0.36, 0.54, 0.76, 1], outputRange: ["0deg", "0deg", "-8deg", "-1.6deg", "0deg", "0deg"], extrapolate: "clamp" }) },
      { scaleY: progress.interpolate({ inputRange: [0, 0.14, 0.36, 0.54, 0.76, 1], outputRange: [1, 1, 0.78, 0.95, 1, 1], extrapolate: "clamp" }) },
    ],
    opacity: progress.interpolate({ inputRange: [0, 0.14, 0.36, 0.54, 0.76, 1], outputRange: [1, 1, 0.8, 0.96, 1, 1], extrapolate: "clamp" }),
  };
  const lowerStyle = {
    transform: [
      { translateY: progress.interpolate({ inputRange: [0, 0.3, 0.5, 0.72, 0.9, 1], outputRange: [0, 0, 3.2, 0.58, 0, 0], extrapolate: "clamp" }) },
      { rotate: progress.interpolate({ inputRange: [0, 0.3, 0.5, 0.72, 0.9, 1], outputRange: ["0deg", "0deg", "8deg", "1.5deg", "0deg", "0deg"], extrapolate: "clamp" }) },
      { scaleY: progress.interpolate({ inputRange: [0, 0.3, 0.5, 0.72, 0.9, 1], outputRange: [1, 1, 0.78, 0.95, 1, 1], extrapolate: "clamp" }) },
    ],
    opacity: progress.interpolate({ inputRange: [0, 0.3, 0.5, 0.72, 0.9, 1], outputRange: [1, 1, 0.8, 0.96, 1, 1], extrapolate: "clamp" }),
  };
  return (
    <IconFrame size={size}>
      <SvgLayer size={size} style={upperStyle}>
        <StrokePath color={color} width={focused ? 2.05 : 1.8} d="M13 13.74a2 2 0 0 1-2 0L2.5 8.87a1 1 0 0 1 0-1.74L11 2.26a2 2 0 0 1 2 0l8.5 4.87a1 1 0 0 1 0 1.74z" />
      </SvgLayer>
      <SvgLayer size={size} style={lowerStyle}>
        <StrokePath color={color} width={focused ? 2.05 : 1.8} d="m20 14.285 1.5.845a1 1 0 0 1 0 1.74L13 21.74a2 2 0 0 1-2 0l-8.5-4.87a1 1 0 0 1 0-1.74l1.5-.845" />
      </SvgLayer>
    </IconFrame>
  );
}

function ActivityGlyph({ color, size, focused, selected }: Omit<AnimatedTabIconProps, "name" | "route"> & { selected: boolean }) {
  const progress = useTabProgress(selected, 480);
  const leftStyle = {
    opacity: progress.interpolate({ inputRange: [0, 0.12, 0.34, 0.54, 0.76, 1], outputRange: [1, 1, 0.78, 0.95, 1, 1], extrapolate: "clamp" }),
    transform: [
      { translateX: progress.interpolate({ inputRange: [0, 0.12, 0.34, 0.54, 0.76, 1], outputRange: [0, 0, -2.8, -0.56, 0, 0], extrapolate: "clamp" }) },
      { scaleX: progress.interpolate({ inputRange: [0, 0.12, 0.34, 0.54, 0.76, 1], outputRange: [1, 1, 0.72, 0.94, 1, 1], extrapolate: "clamp" }) },
    ],
  };
  const rightStyle = {
    opacity: progress.interpolate({ inputRange: [0, 0.3, 0.52, 0.72, 0.9, 1], outputRange: [1, 1, 0.78, 0.95, 1, 1], extrapolate: "clamp" }),
    transform: [
      { translateX: progress.interpolate({ inputRange: [0, 0.3, 0.52, 0.72, 0.9, 1], outputRange: [0, 0, 2.8, 0.5, 0, 0], extrapolate: "clamp" }) },
      { scaleX: progress.interpolate({ inputRange: [0, 0.3, 0.52, 0.72, 0.9, 1], outputRange: [1, 1, 0.72, 0.94, 1, 1], extrapolate: "clamp" }) },
    ],
  };
  const pulseStyle = {
    opacity: progress.interpolate({ inputRange: [0, 0.38, 0.52, 0.68, 1], outputRange: [0, 0, 1, 0, 0], extrapolate: "clamp" }),
    transform: [{ scale: progress.interpolate({ inputRange: [0, 0.38, 0.52, 0.68, 1], outputRange: [0.25, 0.25, 1.75, 0.85, 0.25], extrapolate: "clamp" }) }],
  };
  return (
    <IconFrame size={size}>
      <SvgLayer size={size} style={leftStyle}>
        <StrokePath color={color} width={focused ? 2.05 : 1.8} d="M2 12h2.49a2 2 0 0 0 1.93-1.46l2.35-8.36" />
      </SvgLayer>
      <SvgLayer size={size} style={rightStyle}>
        <StrokePath color={color} width={focused ? 2.05 : 1.8} d="M9.24 2.18l5.52 19.64a.25.25 0 0 0 .48 0l2.35-8.36A2 2 0 0 1 19.52 12H22" />
      </SvgLayer>
      <SvgLayer size={size} style={pulseStyle}>
        <Circle cx="19.5" cy="12" r="1.15" fill={color} />
      </SvgLayer>
    </IconFrame>
  );
}

function UserGlyph({ color, size, focused, selected }: Omit<AnimatedTabIconProps, "name" | "route"> & { selected: boolean }) {
  const progress = useTabProgress(selected, 400);
  const headStyle = {
    opacity: progress.interpolate({ inputRange: [0, 0.2, 0.42, 0.62, 0.82, 1], outputRange: [1, 1, 0.82, 0.96, 1, 1], extrapolate: "clamp" }),
    transform: [
      { translateY: progress.interpolate({ inputRange: [0, 0.2, 0.42, 0.62, 0.82, 1], outputRange: [0, 0, -2.8, -0.45, 0, 0], extrapolate: "clamp" }) },
      { scale: progress.interpolate({ inputRange: [0, 0.2, 0.42, 0.62, 0.82, 1], outputRange: [1, 1, 0.72, 0.95, 1, 1], extrapolate: "clamp" }) },
    ],
  };
  const bodyStyle = {
    opacity: progress.interpolate({ inputRange: [0, 0.32, 0.54, 0.76, 0.92, 1], outputRange: [1, 1, 0.82, 0.96, 1, 1], extrapolate: "clamp" }),
    transform: [
      { translateY: progress.interpolate({ inputRange: [0, 0.32, 0.54, 0.76, 0.92, 1], outputRange: [0, 0, 3, 0.48, 0, 0], extrapolate: "clamp" }) },
      { scaleX: progress.interpolate({ inputRange: [0, 0.32, 0.54, 0.76, 0.92, 1], outputRange: [1, 1, 0.78, 0.95, 1, 1], extrapolate: "clamp" }) },
      { scaleY: progress.interpolate({ inputRange: [0, 0.32, 0.54, 0.76, 0.92, 1], outputRange: [1, 1, 0.68, 0.94, 1, 1], extrapolate: "clamp" }) },
    ],
  };
  return (
    <IconFrame size={size}>
      <SvgLayer size={size} style={headStyle}>
        <Circle cx="12" cy="8" r="5" stroke={color} strokeWidth={focused ? 2.05 : 1.8} />
      </SvgLayer>
      <SvgLayer size={size} style={bodyStyle}>
        <StrokePath color={color} width={focused ? 2.05 : 1.8} d="M20 21a8 8 0 0 0-16 0" />
      </SvgLayer>
    </IconFrame>
  );
}
