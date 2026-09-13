import { Link, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, Image, Platform, Pressable, Text, View, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, { ReduceMotion, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { clearImageViewerPayload, getImageViewerPayload } from "@/src/data/image-viewer";
import { useTranslation } from "@/src/i18n";
import { typography } from "@/src/theme";
import { AppIcon } from "@/src/ui";

/**
 * Full-screen image viewer. Opened as a Link with an Apple zoom source, so on iOS 18+
 * the tapped thumbnail grows into this screen and can be dismissed interactively.
 */
export default function ImageViewerScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { width, height } = useWindowDimensions();
  const [payload] = useState(() => getImageViewerPayload());
  const [index, setIndex] = useState(() => payload?.index ?? 0);

  // One-shot payload: a deep link or restored state must not reopen the last gallery.
  useEffect(() => clearImageViewerPayload, []);

  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, [router]);
  const dismissY = useSharedValue(0);
  const dismissScale = useSharedValue(1);
  const closeProgress = useSharedValue(0);
  const dismissGesture = useMemo(() => Gesture.Pan()
    .enabled(Platform.OS === "android")
    .activeOffsetY([-12, 12])
    .failOffsetX([-18, 18])
    .onUpdate((event) => {
      const distance = Math.max(0, event.translationY);
      dismissY.set(distance);
      dismissScale.set(Math.max(0.84, 1 - distance / 1800));
      closeProgress.set(Math.min(1, distance / 360));
    })
    .onEnd((event) => {
      const shouldClose = event.translationY > 150 || event.velocityY > 900;
      if (shouldClose) {
        dismissY.set(withTiming(760, { duration: 180, reduceMotion: ReduceMotion.System }, (finished) => {
          if (finished) scheduleOnRN(close);
        }));
        dismissScale.set(withTiming(0.86, { duration: 180, reduceMotion: ReduceMotion.System }));
        closeProgress.set(withTiming(1, { duration: 180, reduceMotion: ReduceMotion.System }));
      } else {
        dismissY.set(withSpring(0, { duration: 300, dampingRatio: 0.8, velocity: event.velocityY, reduceMotion: ReduceMotion.System }));
        dismissScale.set(withSpring(1, { duration: 300, dampingRatio: 0.8, velocity: event.velocityY, reduceMotion: ReduceMotion.System }));
        closeProgress.set(withTiming(0, { duration: 180, reduceMotion: ReduceMotion.System }));
      }
    }), [close, closeProgress, dismissScale, dismissY]);
  const viewerStyle = useAnimatedStyle(() => ({ transform: [{ translateY: dismissY.get() }, { scale: dismissScale.get() }] }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: 1 - closeProgress.get() * 0.75 }));
  const closeButtonStyle = {
    position: "absolute" as const,
    zIndex: 2,
    top: insets.top + 8,
    right: 14,
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    backgroundColor: "rgba(255,255,255,0.14)",
  };

  // Explicit dimensions: the native Link.AppleZoomTarget wrapper is content-sized, so
  // percentage-sized children would collapse inside it.
  const imageStyle = { width: width - 24, height: height * 0.82 };

  if (!payload || payload.uris.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: "#000000" }}>
        <StatusBar style="light" />
        <Pressable accessibilityRole="button" accessibilityLabel={t("imageViewer.close")} hitSlop={6} onPress={close} style={closeButtonStyle}>
          <AppIcon name="x" size={22} color="#ffffff" />
        </Pressable>
      </View>
    );
  }

  return (
    <Reanimated.View style={[{ flex: 1, backgroundColor: "#000000" }, viewerStyle]}>
      <Reanimated.View pointerEvents="none" style={[{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "#000000" }, backdropStyle]} />
      <StatusBar style="light" />
      <GestureDetector gesture={dismissGesture}>
      <FlatList
        data={payload.uris}
        horizontal
        pagingEnabled
        initialScrollIndex={payload.index}
        getItemLayout={(_, itemIndex) => ({ length: width, offset: width * itemIndex, index: itemIndex })}
        onMomentumScrollEnd={(event) => setIndex(Math.round(event.nativeEvent.contentOffset.x / width))}
        keyExtractor={(uri, itemIndex) => `${uri}-${itemIndex}`}
        showsHorizontalScrollIndicator={false}
        renderItem={({ item: uri, index: itemIndex }) => (
          <View style={{ width, height, alignItems: "center", justifyContent: "center", paddingHorizontal: 12 }}>
            {itemIndex === payload.index ? (
              <Link.AppleZoomTarget>
                <Image source={{ uri }} resizeMode="contain" style={imageStyle} />
              </Link.AppleZoomTarget>
            ) : (
              <Image source={{ uri }} resizeMode="contain" style={imageStyle} />
            )}
          </View>
        )}
      />
      </GestureDetector>
      <Pressable accessibilityRole="button" accessibilityLabel={t("imageViewer.close")} hitSlop={6} onPress={close} style={closeButtonStyle}>
        <AppIcon name="x" size={22} color="#ffffff" />
      </Pressable>
      <View pointerEvents="none" style={{ position: "absolute", zIndex: 2, top: insets.top + 19, left: 18 }}>
        <Text style={[typography.caption, { color: "#ffffff" }]}>{index + 1} / {payload.uris.length}</Text>
      </View>
    </Reanimated.View>
  );
}
