import { Link } from "expo-router";
import { Pressable } from "react-native";
import { useCurrentUser } from "@/src/auth/current-user";
import { Avatar } from "@/src/ui";

/** Tapping the avatar pushes Profile; on iOS 18+ it zooms out of the avatar itself. */
export function AccountAvatar({ size = 38, online = false }: { size?: number; online?: boolean }) {
  const { name, avatar } = useCurrentUser();
  return (
    <Link href="/profile" asChild>
      <Link.Trigger withAppleZoom>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open profile"
          hitSlop={5}
          style={({ pressed }) => ({ opacity: pressed ? 0.72 : 1 })}
        >
          <Avatar name={name} uri={avatar} size={size} online={online} />
        </Pressable>
      </Link.Trigger>
    </Link>
  );
}
