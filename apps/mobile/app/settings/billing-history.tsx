import { useLocalSearchParams } from "expo-router";
import { BillingHistoryScreen } from "@/src/components/BillingHistoryScreen";

export default function BillingHistoryRoute() {
  const { kind } = useLocalSearchParams<{ kind?: string | string[] }>();
  return <BillingHistoryScreen kind={kind === "subscriptions" ? "subscriptions" : "history"} />;
}
