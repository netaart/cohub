import { Link } from "expo-router";
import { useState } from "react";
import { Pressable } from "react-native";
import { useCurrentUser } from "@/src/auth/current-user";
import { useTranslation } from "@/src/i18n";
import { Avatar } from "@/src/ui";

/** On iOS 18+ Settings zooms out of the account avatar. */
export function AccountAvatar({ size = 38, online = false }: { size?: number; online?: boolean }) {
  const { name, avatar } = useCurrentUser();
  const { t } = useTranslation();
  const [pressed, setPressed] = useState(false);
  return (
    <Link href="/settings" asChild>
      <Link.Trigger withAppleZoom>
        {/* Link.Trigger slots its child, and slotting spreads the child's style prop:
            a function style would be flattened to {}. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("settings.title")}
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
