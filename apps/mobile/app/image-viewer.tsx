import { Link, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { FlatList, Image, Pressable, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { clearImageViewerPayload, getImageViewerPayload } from "@/src/data/image-viewer";
import { typography } from "@/src/theme";
import { AppIcon } from "@/src/ui";

/**
 * Full-screen image viewer. Opened as a Link with an Apple zoom source, so on iOS 18+
 * the tapped thumbnail grows into this screen and can be dismissed interactively.
 */
export default function ImageViewerScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [payload] = useState(() => getImageViewerPayload());
  const [index, setIndex] = useState(() => payload?.index ?? 0);

  // One-shot payload: a deep link or restored state must not reopen the last gallery.
  useEffect(() => clearImageViewerPayload, []);

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };
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

  if (!payload || payload.uris.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: "#000000" }}>
        <StatusBar style="light" />
        <Pressable accessibilityRole="button" accessibilityLabel="Close image viewer" hitSlop={6} onPress={close} style={closeButtonStyle}>
          <AppIcon name="x" size={22} color="#ffffff" />
        </Pressable>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: "#000000" }}>
      <StatusBar style="light" />
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
                <Image source={{ uri }} resizeMode="contain" style={{ width: "100%", height: "82%" }} />
              </Link.AppleZoomTarget>
            ) : (
              <Image source={{ uri }} resizeMode="contain" style={{ width: "100%", height: "82%" }} />
            )}
          </View>
        )}
      />
      <Pressable accessibilityRole="button" accessibilityLabel="Close image viewer" hitSlop={6} onPress={close} style={closeButtonStyle}>
        <AppIcon name="x" size={22} color="#ffffff" />
      </Pressable>
      <View pointerEvents="none" style={{ position: "absolute", zIndex: 2, top: insets.top + 19, left: 18 }}>
        <Text style={[typography.caption, { color: "#ffffff" }]}>{index + 1} / {payload.uris.length}</Text>
      </View>
    </View>
  );
}
