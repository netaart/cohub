import { Link } from "expo-router";
import { useState } from "react";
import { Pressable } from "react-native";
import { useCurrentUser } from "@/src/auth/current-user";
import { Avatar } from "@/src/ui";

/** Tapping the avatar pushes Profile; on iOS 18+ it zooms out of the avatar itself. */
export function AccountAvatar({ size = 38, online = false }: { size?: number; online?: boolean }) {
  const { name, avatar } = useCurrentUser();
  const [pressed, setPressed] = useState(false);
  return (
    <Link href="/profile" asChild>
      <Link.Trigger withAppleZoom>
        {/* Link.Trigger slots its child, and slotting spreads the child's style prop:
            a function style would be flattened to {}. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open profile"
          hitSlop={5}
          onPressIn={() => setPressed(true)}
          onPressOut={() => setPressed(false)}
          style={{ opacity: pressed ? 0.72 : 1 }}
        >
          <Avatar name={name} uri={avatar} size={size} online={online} />
        </Pressable>
      </Link.Trigger>
    </Link>
  );
}
