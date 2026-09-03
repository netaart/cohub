import { useLocalSearchParams } from "expo-router";
import { SettingsScreen } from "@/src/components/SettingsScreen";

type Params = { section?: string | string[] };

const sections = new Set([
	"profile",
	"appearance",
	"about",
	"activity",
	"notifications",
	"rules",
	"channels",
	"billing",
	"referrals",
]);

export default function SettingsRoute() {
	const params = useLocalSearchParams<Params>();
	const raw = Array.isArray(params.section)
		? params.section[0]
		: params.section;
	const section =
		raw && sections.has(raw)
			? (raw as Parameters<typeof SettingsScreen>[0]["initialSection"])
			: undefined;
	return <SettingsScreen key={section ?? "profile"} initialSection={section} />;
}
