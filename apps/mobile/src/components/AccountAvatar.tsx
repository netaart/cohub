import { Pressable } from "react-native";
import { useCurrentUser } from "@/src/auth/current-user";
import { Avatar } from "@/src/ui";

export function AccountAvatar({ onPress, size = 38, online = false }: { onPress: () => void; size?: number; online?: boolean }) {
  const { name, avatar } = useCurrentUser();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open profile"
      onPress={onPress}
      hitSlop={5}
      style={({ pressed }) => ({ opacity: pressed ? 0.72 : 1 })}
    >
      <Avatar name={name} uri={avatar} size={size} online={online} />
    </Pressable>
  );
}
