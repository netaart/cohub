import type { SessionTurnIndexItem } from "@neta-art/cohub";
import { useMemo, useState } from "react";
import {
	ActivityIndicator,
	FlatList,
	Pressable,
	Text,
	View,
} from "react-native";
import { AdaptiveSheet } from "@/src/components/AdaptiveSheet";
import { turnIndexPreview } from "@/src/data/session-history";
import { useAppTheme, typography } from "@/src/theme";
import { AppIcon, SearchField, StatusPill } from "@/src/ui";
import { formatRelativeTime } from "@/src/utils";

type TurnNavigatorSheetProps = {
	visible: boolean;
	turns: SessionTurnIndexItem[];
	currentSequence: number | null;
	loading: boolean;
	loadingSequence: number | null;
	onClose: () => void;
	onJump: (sequence: number) => void | Promise<void>;
	onRetry: () => void;
};

function statusTone(
	status: SessionTurnIndexItem["status"],
): "success" | "warning" | "danger" | "neutral" {
	if (status === "failed") return "danger";
	if (
		status === "running" ||
		status === "queued" ||
		status === "abort_requested"
	)
		return "warning";
	if (status === "interrupted" || status === "cancelled") return "neutral";
	return "success";
}

function statusLabel(status: SessionTurnIndexItem["status"]) {
	if (status === "completed") return "Done";
	if (status === "failed") return "Failed";
	if (status === "running") return "Running";
	if (status === "queued") return "Queued";
	if (status === "interrupted" || status === "cancelled") return "Stopped";
	return status;
}

export function TurnNavigatorSheet({
	visible,
	turns,
	currentSequence,
	loading,
	loadingSequence,
	onClose,
	onJump,
	onRetry,
}: TurnNavigatorSheetProps) {
	const theme = useAppTheme();
	const [query, setQuery] = useState("");
	const filteredTurns = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) return turns;
		return turns.filter((turn) => {
			return [
				String(turn.sequence),
				`#${turn.sequence}`,
				turnIndexPreview(turn),
				turn.provider ?? "",
				turn.model ?? "",
				turn.authorProfile?.displayName ?? "",
			].some((value) => value.toLowerCase().includes(needle));
		});
	}, [query, turns]);

	return (
		<AdaptiveSheet
			visible={visible}
			title="Conversation turns"
			subtitle={
				turns.length > 0
					? `${turns.length} turns · select a point in this Chat`
					: "Jump to any point in this Chat"
			}
			onClose={onClose}
			scrollable={false}
			testID="chat-turn-navigator-sheet"
		>
			<SearchField
				value={query}
				onChangeText={setQuery}
				placeholder="Search turns"
			/>
			{loading && turns.length === 0 ? (
				<View style={styles.state}>
					<ActivityIndicator size="small" color={theme.colors.accent} />
					<Text
						style={[
							typography.caption,
							{ color: theme.colors.textMuted, marginTop: 10 },
						]}
					>
						Loading conversation index
					</Text>
				</View>
			) : filteredTurns.length === 0 ? (
				<View style={styles.state}>
					<AppIcon
						name={query ? "search" : "messages"}
						size={25}
						color={theme.colors.textMuted}
					/>
					<Text
						style={[
							typography.body,
							{
								color: theme.colors.textMuted,
								textAlign: "center",
								marginTop: 10,
							},
						]}
					>
						{query
							? "No matching turns"
							: "The conversation index is unavailable"}
					</Text>
					{!query ? (
						<Pressable
							accessibilityRole="button"
							accessibilityLabel="Retry loading conversation index"
							onPress={onRetry}
							style={({ pressed }) => ({
								marginTop: 12,
								opacity: pressed ? 0.6 : 1,
							})}
						>
							<Text
								style={[typography.bodyMedium, { color: theme.colors.accent }]}
							>
								Retry
							</Text>
						</Pressable>
					) : null}
				</View>
			) : (
				<FlatList
					data={filteredTurns}
					keyExtractor={(turn) => `${turn.sequence}:${turn.id}`}
					style={{ marginTop: 10, maxHeight: "62%" }}
					contentContainerStyle={{ paddingBottom: 12 }}
					keyboardShouldPersistTaps="handled"
					renderItem={({ item: turn }) => {
						const selected = turn.sequence === currentSequence;
						const preview = turnIndexPreview(turn);
						return (
							<Pressable
								accessibilityRole="button"
								accessibilityLabel={`Jump to turn ${turn.sequence}`}
								accessibilityState={{ selected }}
								disabled={loadingSequence !== null}
								onPress={() => void onJump(turn.sequence)}
								android_ripple={{ color: theme.colors.pressOverlay }}
								style={({ pressed }) => [
									styles.row,
									{
										backgroundColor: pressed
											? theme.colors.surfacePressed
											: selected
												? theme.colors.accentSoft
												: "transparent",
										borderColor: selected
											? theme.colors.accentBorder
											: "transparent",
										opacity:
											loadingSequence !== null &&
											loadingSequence !== turn.sequence
												? 0.55
												: 1,
									},
								]}
							>
								<View style={styles.sequence}>
									<Text
										style={[
											typography.caption,
											{
												color: selected
													? theme.colors.accent
													: theme.colors.textFaint,
												fontVariant: ["tabular-nums"],
											},
										]}
									>
										#{turn.sequence}
									</Text>
								</View>
								<View style={styles.rowText}>
									<Text
										numberOfLines={3}
										style={[typography.body, { color: theme.colors.text }]}
									>
										{preview}
									</Text>
									<View style={styles.meta}>
										<Text
											numberOfLines={1}
											style={[
												typography.micro,
												{ color: theme.colors.textFaint, flex: 1 },
											]}
										>
											{formatRelativeTime(turn.createdAt)}
											{turn.provider ? ` · ${turn.provider}` : ""}
											{turn.model ? ` · ${turn.model}` : ""}
										</Text>
										<StatusPill
											label={statusLabel(turn.status)}
											tone={statusTone(turn.status)}
										/>
									</View>
								</View>
								{loadingSequence === turn.sequence ? (
									<ActivityIndicator size="small" color={theme.colors.accent} />
								) : selected ? (
									<AppIcon name="check" size={17} color={theme.colors.accent} />
								) : (
									<AppIcon
										name="chevron-right"
										size={16}
										color={theme.colors.textFaint}
									/>
								)}
							</Pressable>
						);
					}}
				/>
			)}
		</AdaptiveSheet>
	);
}

const styles = {
	state: {
		minHeight: 220,
		alignItems: "center" as const,
		justifyContent: "center" as const,
		paddingHorizontal: 24,
	},
	row: {
		minHeight: 72,
		borderWidth: 1,
		borderRadius: 11,
		paddingHorizontal: 10,
		paddingVertical: 9,
		marginBottom: 4,
		flexDirection: "row" as const,
		alignItems: "center" as const,
		gap: 9,
	},
	sequence: {
		width: 38,
		alignSelf: "stretch" as const,
		justifyContent: "flex-start" as const,
		paddingTop: 2,
	},
	rowText: {
		flex: 1,
		minWidth: 0,
	},
	meta: {
		flexDirection: "row" as const,
		alignItems: "center" as const,
		gap: 7,
		marginTop: 5,
	},
} satisfies Record<string, object>;
