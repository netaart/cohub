import * as ImagePicker from "expo-image-picker";
import { File as ExpoFile } from "expo-file-system";
import type {
	BillingCatalog,
	BillingCreditStatus,
	Channel,
	CohubClient,
	ReferralDashboard,
	UserActivityResponse,
	UserProfile,
	UserRulesResponse,
} from "@neta-art/cohub";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
	ActivityIndicator,
	Linking,
	Platform,
	Pressable,
	ScrollView,
	Share,
	Text,
	TextInput,
	View,
} from "react-native";
import { AdaptiveSheet } from "@/src/components/AdaptiveSheet";
import { useProfileSession } from "@/src/auth/profile-session";
import { useApp } from "@/src/data/context";
import { useTranslation, type TranslationKey } from "@/src/i18n";
import { getInstalledAppVersion } from "@/src/platform/app-updates";
import {
	registerForPushNotifications,
	type PushRegistrationResult,
} from "@/src/platform/notifications";
import { useAppTheme, typography } from "@/src/theme";
import {
	AppIcon,
	Avatar,
	DetailTopBar,
	EmptyState,
	IconButton,
	PrimaryButton,
	Screen,
	SectionHeader,
	StatusPill,
} from "@/src/ui";
import { formatNumber, formatRelativeTime } from "@/src/utils";

type SettingsSection =
	| "profile"
	| "activity"
	| "notifications"
	| "rules"
	| "channels"
	| "billing"
	| "referrals";

type ProfileState = {
	profile: UserProfile | null;
	email: string | null;
	uuid: string;
};

type SettingsScreenProps = {
	initialSection?: SettingsSection;
};

const sections: {
	id: SettingsSection;
	labelKey: TranslationKey;
	icon: React.ComponentProps<typeof AppIcon>["name"];
}[] = [
	{ id: "profile", labelKey: "settings.section.profile", icon: "user" },
	{ id: "activity", labelKey: "settings.section.activity", icon: "activity" },
	{ id: "notifications", labelKey: "settings.section.notifications", icon: "bell" },
	{ id: "rules", labelKey: "settings.section.rules", icon: "file-text" },
	{ id: "channels", labelKey: "settings.section.channels", icon: "messages" },
	{ id: "billing", labelKey: "settings.section.billing", icon: "database" },
	{ id: "referrals", labelKey: "settings.section.referrals", icon: "share" },
];

export function SettingsScreen({
	initialSection = "profile",
}: SettingsScreenProps) {
	const router = useRouter();
	const theme = useAppTheme();
	const { t } = useTranslation();
	const { client, installationId, clearCache, getAccessToken } = useApp();
	const [section, setSection] = useState<SettingsSection>(initialSection);
	const [notice, setNotice] = useState<{
		title: string;
		message: string;
	} | null>(null);
	const [signOutOpen, setSignOutOpen] = useState(false);
	const [signingOut, setSigningOut] = useState(false);
	const { signOut } = useProfileSession();

	const closeSignOut = () => {
		if (!signingOut) setSignOutOpen(false);
	};

	const confirmSignOut = async () => {
		if (signingOut) return;
		setSigningOut(true);
		try {
			try {
				await clearCache();
			} catch (error) {
				setNotice({
					title: t("settings.signOut.cacheIncomplete.title"),
					message:
						error instanceof Error
							? t("settings.signOut.cacheIncomplete.body", { error: error.message })
							: t("settings.signOut.cacheIncomplete.fallback"),
				});
			}
			await signOut();
			setSignOutOpen(false);
		} catch (error) {
			setNotice({
				title: t("settings.signOut.failed.title"),
				message: error instanceof Error ? error.message : t("settings.signOut.failed.body"),
			});
		} finally {
			setSigningOut(false);
		}
	};

	return (
		<Screen>
				<DetailTopBar
					title={t("settings.title")}
					subtitle={t("settings.subtitle")}
					onBack={() => router.back()}
				/>
			<ScrollView
				horizontal
				showsHorizontalScrollIndicator={false}
				style={{
					height: 56,
					flexGrow: 0,
					borderBottomWidth: 1,
					borderBottomColor: theme.colors.border,
				}}
				contentContainerStyle={{
					paddingHorizontal: 12,
					alignItems: "center",
					gap: 7,
				}}
			>
				{sections.map((item) => {
					const active = section === item.id;
					const label = t(item.labelKey);
					return (
						<Pressable
							key={item.id}
							accessibilityRole="tab"
							accessibilityState={{ selected: active }}
							accessibilityLabel={label}
							onPress={() => setSection(item.id)}
							style={({ pressed }) => ({
								minHeight: 36,
								paddingHorizontal: 11,
								borderRadius: 9,
								flexDirection: "row",
								alignItems: "center",
								gap: 6,
								borderWidth: 1,
								borderColor: active
									? theme.colors.accentBorder
									: theme.colors.border,
								backgroundColor: active
									? theme.colors.accentSoft
									: pressed
										? theme.colors.surfacePressed
										: theme.colors.surface,
							})}
						>
							<AppIcon
								name={item.icon}
								size={14}
								color={active ? theme.colors.accent : theme.colors.textMuted}
							/>
							<Text
								style={[
									typography.caption,
									{
										color: active
											? theme.colors.accent
											: theme.colors.textMuted,
									},
								]}
							>
								{label}
							</Text>
						</Pressable>
					);
				})}
			</ScrollView>
			<ScrollView
				style={{ flex: 1 }}
				contentContainerStyle={{ paddingBottom: 34 }}
				keyboardShouldPersistTaps="handled"
			>
				{section === "profile" ? (
					<ProfileSection client={client} onNotice={setNotice} />
				) : null}
				{section === "activity" ? <ActivitySection client={client} /> : null}
				{section === "notifications" ? (
					<NotificationsSection
						client={client}
						installationId={installationId}
						getAccessToken={getAccessToken}
						onNotice={setNotice}
					/>
				) : null}
				{section === "rules" ? <RulesSection client={client} /> : null}
				{section === "channels" ? (
					<ChannelsSection client={client} onNotice={setNotice} />
				) : null}
				{section === "billing" ? (
					<BillingSection client={client} onNotice={setNotice} />
				) : null}
				{section === "referrals" ? (
					<ReferralsSection client={client} onNotice={setNotice} />
				) : null}
				<View style={{ paddingHorizontal: 16, paddingTop: 30 }}>
					<Pressable
						accessibilityRole="button"
						accessibilityLabel={t("settings.signOut.action")}
						onPress={() => setSignOutOpen(true)}
						style={({ pressed }) => ({
							minHeight: 48,
							borderWidth: 1,
							borderColor: theme.colors.danger,
							borderRadius: 12,
							alignItems: "center",
							justifyContent: "center",
							backgroundColor: pressed
								? theme.colors.dangerSoft
								: "transparent",
						})}
					>
						<Text
							style={[typography.bodyMedium, { color: theme.colors.danger }]}
						>
							{signingOut ? t("settings.signOut.signingOut") : t("settings.signOut.action")}
						</Text>
					</Pressable>
					<Text
						style={[
							typography.micro,
							{
								color: theme.colors.textFaint,
								textAlign: "center",
								marginTop: 18,
							},
						]}
					>
						Cohub Mobile · {getInstalledAppVersion()}
					</Text>
				</View>
			</ScrollView>
			<AdaptiveSheet
				visible={notice !== null}
				title={notice?.title ?? t("common.notice")}
				onClose={() => setNotice(null)}
				scrollable={false}
				footer={
					<View style={{ alignItems: "flex-end" }}>
						<PrimaryButton
							label={t("common.done")}
							onPress={() => setNotice(null)}
							style={{ minHeight: 44, paddingHorizontal: 18 }}
						/>
					</View>
				}
				testID="settings-notice-sheet"
			>
				<Text style={[typography.body, { color: theme.colors.textSecondary }]}>
					{notice?.message ?? ""}
				</Text>
			</AdaptiveSheet>
			<AdaptiveSheet
				visible={signOutOpen}
				title={t("settings.signOut.title")}
				subtitle={t("settings.signOut.subtitle")}
				onClose={closeSignOut}
				dismissible={!signingOut}
				scrollable={false}
				testID="settings-sign-out-sheet"
				footer={
					<View
						style={{
							flexDirection: "row",
							justifyContent: "flex-end",
							gap: 10,
						}}
					>
						<Pressable
							disabled={signingOut}
							onPress={closeSignOut}
							style={{
								minHeight: 46,
								paddingHorizontal: 15,
								justifyContent: "center",
							}}
						>
							<Text
								style={[
									typography.bodyMedium,
									{ color: theme.colors.textSecondary },
								]}
							>
								{t("common.cancel")}
							</Text>
						</Pressable>
						<PrimaryButton
							label={t("common.signOut")}
							icon="arrow-right"
							tone="danger"
							loading={signingOut}
							onPress={() => void confirmSignOut()}
							style={{ minHeight: 46, paddingHorizontal: 16 }}
						/>
					</View>
				}
			>
				<Text style={[typography.body, { color: theme.colors.textSecondary }]}>
					{t("settings.signOut.body")}
				</Text>
			</AdaptiveSheet>
		</Screen>
	);
}

function SettingsIntro({
	title,
	description,
}: {
	title: string;
	description: string;
}) {
	const theme = useAppTheme();
	return (
		<View style={{ paddingHorizontal: 16, paddingTop: 22, paddingBottom: 8 }}>
			<Text style={[typography.title, { color: theme.colors.text }]}>
				{title}
			</Text>
			<Text
				style={[
					typography.body,
					{ color: theme.colors.textMuted, marginTop: 6, maxWidth: 520 },
				]}
			>
				{description}
			</Text>
		</View>
	);
}

function SettingsGroup({ children }: { children: ReactNode }) {
	const theme = useAppTheme();
	return (
		<View
			style={{
				marginHorizontal: 16,
				marginTop: 13,
				borderWidth: 1,
				borderColor: theme.colors.border,
				borderRadius: 14,
				backgroundColor: theme.colors.surface,
				overflow: "hidden",
			}}
		>
			{children}
		</View>
	);
}

function SettingsRow({
	icon,
	title,
	detail,
	trailing,
	onPress,
	danger = false,
	disabled = false,
}: {
	icon: React.ComponentProps<typeof AppIcon>["name"];
	title: string;
	detail?: string;
	trailing?: ReactNode;
	onPress?: () => void;
	danger?: boolean;
	disabled?: boolean;
}) {
	const theme = useAppTheme();
	const content = (
		<View
			style={{
				minHeight: 66,
				paddingHorizontal: 13,
				paddingVertical: 10,
				flexDirection: "row",
				alignItems: "center",
				gap: 11,
				borderBottomWidth: 1,
				borderBottomColor: theme.colors.border,
			}}
		>
			<View
				style={{
					width: 34,
					height: 34,
					borderRadius: 10,
					alignItems: "center",
					justifyContent: "center",
					backgroundColor: danger
						? theme.colors.dangerSoft
						: theme.colors.surfaceRaised,
				}}
			>
				<AppIcon
					name={icon}
					size={17}
					color={danger ? theme.colors.danger : theme.colors.textMuted}
				/>
			</View>
			<View style={{ flex: 1, minWidth: 0 }}>
				<Text
					style={[
						typography.bodyMedium,
						{ color: danger ? theme.colors.danger : theme.colors.text },
					]}
				>
					{title}
				</Text>
				{detail ? (
					<Text
						numberOfLines={2}
						style={[
							typography.caption,
							{ color: theme.colors.textMuted, marginTop: 2 },
						]}
					>
						{detail}
					</Text>
				) : null}
			</View>
			{trailing}
		</View>
	);
	return onPress ? (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={title}
			disabled={disabled}
			onPress={onPress}
			style={({ pressed }) => ({
				backgroundColor: pressed ? theme.colors.surfacePressed : "transparent",
				opacity: disabled ? 0.55 : 1,
			})}
		>
			{content}
		</Pressable>
	) : (
		content
	);
}

function ProfileSection({
	client,
	onNotice,
}: {
	client: CohubClient | null;
	onNotice: (notice: { title: string; message: string }) => void;
}) {
	const theme = useAppTheme();
	const { t } = useTranslation();
	const { getClaims } = useProfileSession();
	const [data, setData] = useState<ProfileState>({
		profile: null,
		email: null,
		uuid: "",
	});
	const [displayName, setDisplayName] = useState("");
	const [username, setUsername] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [uploadingAvatar, setUploadingAvatar] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		if (!client) {
			setLoading(false);
			setError(t("settings.profile.connect"));
			return;
		}
		setLoading(true);
		setError(null);
		try {
			const [me, claims] = await Promise.all([
				client.user.getMe(),
				getClaims(),
			]);
			const profile = me.profile;
			setData({
				profile,
				email:
					me.email ?? (typeof claims.email === "string" ? claims.email : null),
				uuid: me.uuid,
			});
			setDisplayName(profile.displayName);
			setUsername(profile.username ?? "");
		} catch (caught) {
			setError(
				caught instanceof Error ? caught.message : t("settings.profile.loadError"),
			);
		} finally {
			setLoading(false);
		}
	}, [client, getClaims, t]);

	useEffect(() => {
		void Promise.resolve().then(() => load());
	}, [load]);

	const changeAvatar = async () => {
		if (!client || uploadingAvatar) return;
		setUploadingAvatar(true);
		setError(null);
		try {
			const permission =
				await ImagePicker.requestMediaLibraryPermissionsAsync();
			if (!permission.granted) {
				onNotice({
					title: t("settings.profile.photoOff.title"),
					message: t("settings.profile.photoOff.body"),
				});
				return;
			}
			const result = await ImagePicker.launchImageLibraryAsync({
				mediaTypes: ["images"],
				quality: 0.9,
			});
			if (result.canceled) return;
			const asset = result.assets[0];
			if (!asset) return;
			const file: Blob =
				Platform.OS === "web"
					? await (await fetch(asset.uri)).blob()
					: new ExpoFile(asset.uri);
			const uploaded = await client.publicAssets.upload({
				purpose: "user_avatar",
				file,
				mimeType: file.type || asset.mimeType || "image/jpeg",
				filename: asset.fileName || "avatar.jpg",
			});
			const updated = await client.user.updateProfile({
				avatarUrl: uploaded.publicUrl,
			});
			setData((current) => ({ ...current, profile: updated.profile }));
			onNotice({
				title: t("settings.profile.avatarUpdated.title"),
				message: t("settings.profile.avatarUpdated.body"),
			});
		} catch (caught) {
			setError(
				caught instanceof Error ? caught.message : t("settings.profile.avatarError"),
			);
		} finally {
			setUploadingAvatar(false);
		}
	};

	const save = async () => {
		if (!client || saving || !displayName.trim()) return;
		setSaving(true);
		setError(null);
		try {
			const result = await client.user.updateProfile({
				displayName: displayName.trim(),
				username: username.trim() || null,
			});
			setData((current) => ({ ...current, profile: result.profile }));
			setDisplayName(result.profile.displayName);
			setUsername(result.profile.username ?? "");
			onNotice({
				title: t("settings.profile.updated.title"),
				message: t("settings.profile.updated.body"),
			});
		} catch (caught) {
			setError(
				caught instanceof Error ? caught.message : t("settings.profile.saveError"),
			);
		} finally {
			setSaving(false);
		}
	};

	return (
		<View>
			<SettingsIntro
				title={t("settings.profile.intro.title")}
				description={t("settings.profile.intro.body")}
			/>
			{loading ? (
				<LoadingBlock />
			) : error ? (
				<InlineError message={error} onRetry={() => void load()} />
			) : (
				<>
					<View
						style={{ alignItems: "center", paddingTop: 18, paddingBottom: 8 }}
					>
						<Pressable
							accessibilityRole="button"
							accessibilityLabel={t("settings.profile.changeAvatar")}
							onPress={() => void changeAvatar()}
							disabled={uploadingAvatar}
							style={({ pressed }) => ({
								borderRadius: 28,
								opacity: pressed || uploadingAvatar ? 0.65 : 1,
							})}
						>
							<Avatar
								name={data.profile?.displayName || t("settings.profile.fallbackName")}
								uri={data.profile?.avatarUrl}
								size={82}
								online
							/>
						</Pressable>
						{uploadingAvatar ? (
							<View
								style={{
									flexDirection: "row",
									alignItems: "center",
									gap: 6,
									marginTop: 7,
								}}
							>
								<ActivityIndicator size="small" color={theme.colors.accent} />
								<Text
									style={[
										typography.caption,
										{ color: theme.colors.textMuted },
									]}
								>
									{t("settings.profile.uploadingAvatar")}
								</Text>
							</View>
						) : null}
						<Text
							style={[
								typography.heading,
								{
									color: theme.colors.text,
									marginTop: uploadingAvatar ? 8 : 11,
								},
							]}
						>
							{data.profile?.displayName || t("settings.profile.fallbackName")}
						</Text>
						{data.email ? (
							<Text
								style={[
									typography.caption,
									{ color: theme.colors.textMuted, marginTop: 3 },
								]}
							>
								{data.email}
							</Text>
						) : null}
						<Text
							style={[
								typography.micro,
								{ color: theme.colors.textFaint, marginTop: 6 },
							]}
						>
							{t("settings.profile.tapAvatar")}
						</Text>
					</View>
					<SettingsGroup>
						<View style={{ padding: 14 }}>
							<Text
								style={[
									typography.caption,
									{ color: theme.colors.textSecondary, marginBottom: 6 },
								]}
							>
								{t("settings.profile.displayName")}
							</Text>
							<TextInput
								value={displayName}
								onChangeText={setDisplayName}
								maxLength={120}
								placeholder={t("settings.profile.displayNamePlaceholder")}
								placeholderTextColor={theme.colors.textFaint}
								style={[
									styles.input,
									{
										color: theme.colors.text,
										borderColor: theme.colors.border,
										backgroundColor: theme.colors.background,
										fontSize: typography.body.fontSize,
									},
								]}
							/>
							<Text
								style={[
									typography.caption,
									{
										color: theme.colors.textSecondary,
										marginTop: 14,
										marginBottom: 6,
									},
								]}
							>
								{t("settings.profile.username")}
							</Text>
							<TextInput
								value={username}
								onChangeText={setUsername}
								maxLength={39}
								autoCapitalize="none"
								placeholder={t("settings.profile.usernamePlaceholder")}
								placeholderTextColor={theme.colors.textFaint}
								style={[
									styles.input,
									{
										color: theme.colors.text,
										borderColor: theme.colors.border,
										backgroundColor: theme.colors.background,
										fontSize: typography.body.fontSize,
									},
								]}
							/>
							<PrimaryButton
								label={saving ? t("settings.profile.saving") : t("settings.profile.save")}
								icon="check"
								loading={saving}
								disabled={!displayName.trim()}
								onPress={() => void save()}
								style={{ marginTop: 15 }}
							/>
						</View>
					</SettingsGroup>
					<SectionHeader title={t("settings.profile.section.identity")} />
					<SettingsGroup>
						<SettingsRow
							icon="fingerprint"
							title={t("settings.profile.userId")}
							detail={data.uuid || t("settings.profile.unavailable")}
							trailing={null}
						/>
						<SettingsRow
							icon="user"
							title={t("settings.profile.username")}
							detail={username ? `@${username}` : t("settings.profile.notSet")}
							trailing={null}
						/>
					</SettingsGroup>
				</>
			)}
		</View>
	);
}

function ActivitySection({ client }: { client: CohubClient | null }) {
	const theme = useAppTheme();
	const { t } = useTranslation();
	const [days, setDays] = useState(30);
	const [data, setData] = useState<UserActivityResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const load = useCallback(async () => {
		if (!client) {
			setLoading(false);
			setError(t("settings.activity.connect"));
			return;
		}
		setLoading(true);
		setError(null);
		try {
			setData(await client.user.getActivity({ days }));
		} catch (caught) {
			setError(
				caught instanceof Error ? caught.message : t("settings.activity.error"),
			);
		} finally {
			setLoading(false);
		}
	}, [client, days, t]);
	useEffect(() => {
		void Promise.resolve().then(() => load());
	}, [load]);
	const summary = data?.summary;
	return (
		<View>
			<SettingsIntro
				title={t("settings.activity.intro.title")}
				description={t("settings.activity.intro.body")}
			/>
			<View
				style={{
					flexDirection: "row",
					gap: 8,
					paddingHorizontal: 16,
					paddingTop: 8,
				}}
			>
				{[7, 30, 365].map((value) => (
					<Pressable
						key={value}
						accessibilityRole="button"
						accessibilityState={{ selected: days === value }}
						onPress={() => setDays(value)}
						style={({ pressed }) => ({
							minHeight: 34,
							paddingHorizontal: 12,
							borderRadius: 8,
							justifyContent: "center",
							borderWidth: 1,
							borderColor:
								days === value
									? theme.colors.accentBorder
									: theme.colors.border,
							backgroundColor:
								days === value
									? theme.colors.accentSoft
									: pressed
										? theme.colors.surfacePressed
										: theme.colors.surface,
						})}
					>
						<Text
							style={[
								typography.caption,
								{
									color:
										days === value
											? theme.colors.accent
											: theme.colors.textMuted,
								},
							]}
						>
							{value === 365 ? t("settings.activity.range.oneYear") : t("settings.activity.range.days", { days: value })}
						</Text>
					</Pressable>
				))}
			</View>
			{loading ? (
				<LoadingBlock />
			) : error ? (
				<InlineError message={error} onRetry={() => void load()} />
			) : (
				<>
					<View
						style={{
							flexDirection: "row",
							gap: 8,
							paddingHorizontal: 16,
							paddingTop: 16,
						}}
					>
						<Metric
							label={t("settings.activity.metric.tokens")}
							value={formatNumber(summary?.totalTokens)}
							icon="layers"
						/>
						<Metric
							label={t("settings.activity.metric.requests")}
							value={formatNumber(summary?.requestCount)}
							icon="zap"
						/>
						<Metric
							label={t("settings.activity.metric.success")}
							value={formatNumber(summary?.successCount)}
							icon="check-circle"
						/>
					</View>
					<SectionHeader title={t("settings.activity.topModels")} />
					<SettingsGroup>
						{(data?.rankings.llmModels ?? []).slice(0, 8).map((item, index) => (
							<View
								key={`${item.provider}/${item.model}`}
								style={{
									minHeight: 56,
									paddingHorizontal: 13,
									flexDirection: "row",
									alignItems: "center",
									gap: 10,
									borderBottomWidth: 1,
									borderBottomColor: theme.colors.border,
								}}
							>
								<Text
									style={[
										typography.caption,
										{ width: 22, color: theme.colors.textFaint },
									]}
								>
									{index + 1}
								</Text>
								<View style={{ flex: 1, minWidth: 0 }}>
									<Text
										numberOfLines={1}
										style={[
											typography.bodyMedium,
											{ color: theme.colors.text },
										]}
									>
										{item.model}
									</Text>
									<Text
										numberOfLines={1}
										style={[
											typography.micro,
											{ color: theme.colors.textMuted, marginTop: 2 },
										]}
									>
										{item.provider}
									</Text>
								</View>
								<Text
									style={[
										typography.caption,
										{ color: theme.colors.textSecondary },
									]}
								>
									{formatNumber(item.totalTokens)}
								</Text>
							</View>
						))}
						{(data?.rankings.llmModels ?? []).length === 0 ? (
							<Text
								style={[
									typography.body,
									{ color: theme.colors.textMuted, padding: 16 },
								]}
							>
								{t("settings.activity.noUsage")}
							</Text>
						) : null}
					</SettingsGroup>
				</>
			)}
		</View>
	);
}

function NotificationsSection({
	client,
	installationId,
	getAccessToken,
	onNotice,
}: {
	client: CohubClient | null;
	installationId: string | null;
	getAccessToken: (options?: {
		forceRefresh?: boolean;
	}) => Promise<string | null>;
	onNotice: (notice: { title: string; message: string }) => void;
}) {
	const theme = useAppTheme();
	const { t } = useTranslation();
	const [result, setResult] = useState<PushRegistrationResult | null>(null);
	const [loading, setLoading] = useState(false);
	const enable = async () => {
		if (loading) return;
		setLoading(true);
		try {
			const next = await registerForPushNotifications({
				getAccessToken,
				installationId,
			});
			setResult(next);
			if (next.status === "enabled")
				onNotice({
					title: t("settings.notifications.enabled.title"),
					message: t("settings.notifications.enabled.body"),
				});
			else
				onNotice({ title: t("settings.notifications.unavailable.title"), message: next.message });
		} catch (error) {
			onNotice({
				title: t("settings.notifications.unavailable.title"),
				message:
					error instanceof Error
						? error.message
						: t("settings.notifications.unavailable.body"),
			});
		} finally {
			setLoading(false);
		}
	};
	const status =
		result?.status === "enabled"
			? t("settings.notifications.status.enabled")
			: result?.status === "unavailable"
				? t("settings.notifications.status.needsSetup")
				: t("settings.notifications.status.notConfigured");
	return (
		<View>
			<SettingsIntro
				title={t("settings.notifications.intro.title")}
				description={t("settings.notifications.intro.body")}
			/>
			<SettingsGroup>
				<SettingsRow
					icon="bell"
					title={t("settings.notifications.row.title")}
					detail={
						result?.message ??
						t("settings.notifications.row.detail")
					}
					trailing={
						<StatusPill
							label={status}
							tone={
								result?.status === "enabled"
									? "success"
									: result?.status === "unavailable"
										? "warning"
										: "neutral"
							}
						/>
					}
				/>
				<View style={{ padding: 14 }}>
					<PrimaryButton
						label={loading ? t("settings.notifications.checking") : t("settings.notifications.enable")}
						icon="bell"
						loading={loading}
						onPress={() => void enable()}
						style={{ minHeight: 46 }}
					/>
					{result?.status === "unavailable" &&
					result.reason === "permission-denied" ? (
						<Pressable
							accessibilityRole="button"
							accessibilityLabel={t("settings.notifications.openSystem")}
							onPress={() => void Linking.openSettings()}
							style={({ pressed }) => ({
								marginTop: 11,
								opacity: pressed ? 0.6 : 1,
							})}
						>
							<Text
								style={[typography.bodyMedium, { color: theme.colors.accent }]}
							>
								{t("settings.notifications.openSystem")}
							</Text>
						</Pressable>
					) : null}
					<Text
						style={[
							typography.caption,
							{ color: theme.colors.textMuted, marginTop: 10 },
						]}
					>
						{t("settings.notifications.androidNote")}
					</Text>
				</View>
			</SettingsGroup>
			<SectionHeader title={t("settings.notifications.section.device")} />
			<SettingsGroup>
				<SettingsRow
					icon="fingerprint"
					title={t("settings.notifications.installation")}
					detail={
						installationId
							? `${installationId.slice(0, 8)}…`
							: t("settings.notifications.preparingIdentity")
					}
				/>
				<SettingsRow
					icon="wifi"
					title={t("settings.notifications.delivery")}
					detail={
						client ? t("settings.notifications.connected") : t("settings.notifications.waiting")
					}
				/>
			</SettingsGroup>
		</View>
	);
}

function RulesSection({ client }: { client: CohubClient | null }) {
	const theme = useAppTheme();
	const { t } = useTranslation();
	const [data, setData] = useState<UserRulesResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const load = useCallback(async () => {
		if (!client) {
			setLoading(false);
			setError(t("settings.rules.connect"));
			return;
		}
		setLoading(true);
		setError(null);
		try {
			setData(await client.user.getRules());
		} catch (caught) {
			setError(
				caught instanceof Error ? caught.message : t("settings.rules.error"),
			);
		} finally {
			setLoading(false);
		}
	}, [client, t]);
	useEffect(() => {
		void Promise.resolve().then(() => load());
	}, [load]);
	return (
		<View>
			<SettingsIntro
				title={t("settings.rules.intro.title")}
				description={t("settings.rules.intro.body")}
			/>
			{loading ? (
				<LoadingBlock />
			) : error ? (
				<InlineError message={error} onRetry={() => void load()} />
			) : (
				<SettingsGroup>
					<View style={{ padding: 14 }}>
						<View
							style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
						>
							<AppIcon name="file-text" size={17} color={theme.colors.accent} />
							<Text
								style={[typography.bodyMedium, { color: theme.colors.text }]}
							>
								/configs/user/AGENTS.md
							</Text>
						</View>
						<Text
							style={[
								typography.caption,
								{ color: theme.colors.textMuted, marginTop: 6 },
							]}
						>
							{data?.updatedAt
								? t("settings.rules.updated", { time: formatRelativeTime(data.updatedAt) })
								: t("settings.rules.notPublished")}
						</Text>
						<ScrollView
							horizontal={false}
							style={{ maxHeight: 360, marginTop: 13 }}
						>
							<Text
								selectable
								style={[
									typography.code,
									{
										color: theme.colors.textSecondary,
										fontFamily: "SpaceMono",
									},
								]}
							>
								{data?.content?.trim() || t("settings.rules.none")}
							</Text>
						</ScrollView>
					</View>
				</SettingsGroup>
			)}
		</View>
	);
}

function ChannelsSection({
	client,
	onNotice,
}: {
	client: CohubClient | null;
	onNotice: (notice: { title: string; message: string }) => void;
}) {
	const theme = useAppTheme();
	const { t } = useTranslation();
	const [channels, setChannels] = useState<Channel[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [removeCandidate, setRemoveCandidate] = useState<Channel | null>(null);
	const [removing, setRemoving] = useState(false);
	const load = useCallback(async () => {
		if (!client) {
			setLoading(false);
			setError(t("settings.channels.connect"));
			return;
		}
		setLoading(true);
		setError(null);
		try {
			setChannels(await client.channels.list());
		} catch (caught) {
			setError(
				caught instanceof Error ? caught.message : t("settings.channels.error"),
			);
		} finally {
			setLoading(false);
		}
	}, [client, t]);
	useEffect(() => {
		void Promise.resolve().then(() => load());
	}, [load]);
	const confirmRemove = async () => {
		if (!client || !removeCandidate || removeCandidate.boundSpace || removing)
			return;
		setRemoving(true);
		try {
			await client.channels.delete(removeCandidate.id);
			setChannels((current) =>
				current.filter((item) => item.id !== removeCandidate.id),
			);
			setRemoveCandidate(null);
		} catch (caught) {
			onNotice({
				title: t("settings.channels.removeError.title"),
				message:
					caught instanceof Error
						? caught.message
						: t("settings.channels.removeError.body"),
			});
		} finally {
			setRemoving(false);
		}
	};
	return (
		<View>
			<SettingsIntro
				title={t("settings.channels.intro.title")}
				description={t("settings.channels.intro.body")}
			/>
			{loading ? (
				<LoadingBlock />
			) : error ? (
				<InlineError message={error} onRetry={() => void load()} />
			) : channels.length === 0 ? (
				<EmptyState
					icon="messages"
					title={t("settings.channels.empty.title")}
					description={t("settings.channels.empty.body")}
				/>
			) : (
				<>
					<SettingsGroup>
						{channels.map((channel) => (
							<View
								key={channel.id}
								style={{
									minHeight: 78,
									paddingHorizontal: 13,
									paddingVertical: 11,
									flexDirection: "row",
									alignItems: "center",
									gap: 10,
									borderBottomWidth: 1,
									borderBottomColor: theme.colors.border,
								}}
							>
								<View
									style={{
										width: 35,
										height: 35,
										borderRadius: 10,
										alignItems: "center",
										justifyContent: "center",
										backgroundColor: theme.colors.surfaceRaised,
									}}
								>
									<View
										style={{
											width: 8,
											height: 8,
											borderRadius: 4,
											backgroundColor:
												channel.status === "active"
													? theme.colors.success
													: theme.colors.warning,
										}}
									/>
								</View>
								<View style={{ flex: 1, minWidth: 0 }}>
									<Text
										numberOfLines={1}
										style={[
											typography.bodyMedium,
											{ color: theme.colors.text },
										]}
									>
										{channel.name}
									</Text>
									<Text
										style={[
											typography.caption,
											{ color: theme.colors.textMuted, marginTop: 2 },
										]}
									>
										{channel.provider} ·{" "}
										{channel.boundSpace
											? t("settings.channels.boundTo", { name: channel.boundSpace.title || channel.boundSpace.id.slice(0, 8) })
											: t("settings.channels.notBound")}
									</Text>
								</View>
								{!channel.boundSpace ? (
									<IconButton
										name="trash"
										label={t("settings.channels.remove", { name: channel.name })}
										tone="danger"
										size={38}
										onPress={() => setRemoveCandidate(channel)}
									/>
								) : (
									<StatusPill label={t("settings.channels.bound")} tone="success" />
								)}
							</View>
						))}
					</SettingsGroup>
					<AdaptiveSheet
						visible={removeCandidate !== null}
						title={t("settings.channels.removeSheet.title")}
						subtitle={removeCandidate?.name}
						onClose={() => {
							if (!removing) setRemoveCandidate(null);
						}}
						dismissible={!removing}
						scrollable={false}
						testID="settings-remove-channel-sheet"
						footer={
							<View
								style={{
									flexDirection: "row",
									justifyContent: "flex-end",
									gap: 10,
								}}
							>
								<Pressable
									disabled={removing}
									onPress={() => setRemoveCandidate(null)}
									style={{
										minHeight: 46,
										paddingHorizontal: 15,
										justifyContent: "center",
									}}
								>
									<Text
										style={[
											typography.bodyMedium,
											{ color: theme.colors.textSecondary },
										]}
									>
										{t("common.cancel")}
									</Text>
								</Pressable>
								<PrimaryButton
									label={t("common.remove")}
									icon="trash"
									tone="danger"
									loading={removing}
									onPress={() => void confirmRemove()}
									style={{ minHeight: 46, paddingHorizontal: 16 }}
								/>
							</View>
						}
					>
						<Text
							style={[typography.body, { color: theme.colors.textSecondary }]}
						>
							{t("settings.channels.removeSheet.body")}
						</Text>
					</AdaptiveSheet>
				</>
			)}
		</View>
	);
}

function BillingSection({
	client,
	onNotice,
}: {
	client: CohubClient | null;
	onNotice: (notice: { title: string; message: string }) => void;
}) {
	const theme = useAppTheme();
	const { t } = useTranslation();
	const [credits, setCredits] = useState<BillingCreditStatus | null>(null);
	const [catalog, setCatalog] = useState<BillingCatalog | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [pendingProductKey, setPendingProductKey] = useState<string | null>(null);
	const load = useCallback(async () => {
		if (!client) {
			setLoading(false);
			setError(t("settings.billing.connect"));
			return;
		}
		setLoading(true);
		setError(null);
		try {
			const [credit, catalogResult] = await Promise.all([
				client.billing.getCredits(),
				client.billing.getCatalog(),
			]);
			setCredits(credit);
			setCatalog(catalogResult.catalog);
		} catch (caught) {
			setError(
				caught instanceof Error ? caught.message : t("settings.billing.error"),
			);
		} finally {
			setLoading(false);
		}
	}, [client, t]);
	useEffect(() => {
		void Promise.resolve().then(() => load());
	}, [load]);
	const openProduct = async (
		product: BillingCatalog["plans"][number] | BillingCatalog["addons"][number],
	) => {
		if (!client || pendingProductKey) return;
		setPendingProductKey(product.key);
		try {
			const result =
				product.kind === "plan"
					? await client.billing.createSubscription(product.key)
					: await client.billing.createOrder(product.key);
			const checkout = result.checkout;
			if (!checkout.checkoutUrl) {
				onNotice({
					title: t("settings.billing.checkoutUnavailable.title"),
					message:
						checkout.message ||
						t("settings.billing.checkoutUnavailable.body"),
				});
				return;
			}
			await WebBrowser.openBrowserAsync(checkout.checkoutUrl);
		} catch (caught) {
			onNotice({
				title: t("settings.billing.checkoutUnavailable.title"),
				message:
					caught instanceof Error ? caught.message : t("settings.billing.checkoutError"),
			});
		} finally {
			setPendingProductKey(null);
		}
	};
	return (
		<View>
			<SettingsIntro
				title={t("settings.billing.intro.title")}
				description={t("settings.billing.intro.body")}
			/>
			{loading ? (
				<LoadingBlock />
			) : error ? (
				<InlineError message={error} onRetry={() => void load()} />
			) : (
				<>
					<SettingsGroup>
						<View style={{ padding: 15 }}>
							<Text
								style={[typography.caption, { color: theme.colors.textMuted }]}
							>
								{t("settings.billing.balance")}
							</Text>
							<Text
								style={[
									typography.display,
									{
										color:
											credits && credits.netUsd < 0
												? theme.colors.danger
												: theme.colors.text,
										marginTop: 5,
									},
								]}
							>
								{formatUsd(credits?.netUsd ?? 0)}
							</Text>
						</View>
					</SettingsGroup>
					<SectionHeader title={t("settings.billing.plans")} />
					<SettingsGroup>
						{(catalog?.plans ?? []).slice(0, 8).map((plan) => (
							<SettingsRow
								key={plan.key}
								icon="zap"
								title={plan.name}
								detail={plan.description || t("settings.billing.planFallback")}
								disabled={pendingProductKey !== null}
								onPress={() => void openProduct(plan)}
								trailing={
									<Text
										style={[
											typography.caption,
											{ color: theme.colors.textSecondary },
										]}
									>
										{formatUsd(plan.pricing.amountUsd)}
									</Text>
								}
							/>
						))}
						{(catalog?.plans ?? []).length === 0 ? (
							<Text
								style={[
									typography.body,
									{ color: theme.colors.textMuted, padding: 16 },
								]}
							>
								{t("settings.billing.noPlans")}
							</Text>
						) : null}
					</SettingsGroup>
					{(catalog?.addons ?? []).length > 0 ? (
						<>
							<SectionHeader title={t("settings.billing.creditPackages")} />
							<SettingsGroup>
								{(catalog?.addons ?? []).slice(0, 8).map((addon) => (
									<SettingsRow
										key={addon.key}
										icon="zap"
										title={addon.name}
										detail={addon.description || t("settings.billing.addonFallback")}
										disabled={pendingProductKey !== null}
										onPress={() => void openProduct(addon)}
										trailing={
											<Text
												style={[
													typography.caption,
													{ color: theme.colors.textSecondary },
												]}
											>
												{formatUsd(addon.pricing.amountUsd)}
											</Text>
										}
									/>
								))}
							</SettingsGroup>
						</>
					) : null}
				</>
			)}
		</View>
	);
}

function ReferralsSection({
	client,
	onNotice,
}: {
	client: CohubClient | null;
	onNotice: (notice: { title: string; message: string }) => void;
}) {
	const theme = useAppTheme();
	const { t } = useTranslation();
	const [data, setData] = useState<ReferralDashboard | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const load = useCallback(async () => {
		if (!client) {
			setLoading(false);
			setError(t("settings.referrals.connect"));
			return;
		}
		setLoading(true);
		setError(null);
		try {
			setData(await client.referrals.getMine());
		} catch (caught) {
			setError(
				caught instanceof Error ? caught.message : t("settings.referrals.error"),
			);
		} finally {
			setLoading(false);
		}
	}, [client, t]);
	useEffect(() => {
		void Promise.resolve().then(() => load());
	}, [load]);
	const share = async () => {
		if (!data) return;
		const url = `https://cohub.live/referrals/${data.code}`;
		try {
			await Share.share({ title: t("settings.referrals.shareTitle"), message: url });
		} catch {
			onNotice({
				title: t("settings.referrals.shareUnavailable.title"),
				message: t("settings.referrals.shareUnavailable.body"),
			});
		}
	};
	return (
		<View>
			<SettingsIntro
				title={t("settings.referrals.intro.title")}
				description={t("settings.referrals.intro.body")}
			/>
			{loading ? (
				<LoadingBlock />
			) : error || !data ? (
				<InlineError
					message={error || t("settings.referrals.unavailable")}
					onRetry={() => void load()}
				/>
			) : (
				<>
					<SettingsGroup>
						<View style={{ padding: 15 }}>
							<Text
								style={[typography.caption, { color: theme.colors.textMuted }]}
							>
								{t("settings.referrals.link")}
							</Text>
							<Text
								selectable
								style={[
									typography.bodyMedium,
									{ color: theme.colors.text, marginTop: 7 },
								]}
							>
								https://cohub.live/referrals/{data.code}
							</Text>
							<PrimaryButton
								label={t("settings.referrals.share")}
								icon="share"
								onPress={() => void share()}
								style={{ marginTop: 14 }}
							/>
						</View>
					</SettingsGroup>
					<View
						style={{
							flexDirection: "row",
							gap: 8,
							paddingHorizontal: 16,
							paddingTop: 14,
						}}
					>
						<Metric
							label={t("settings.referrals.rewarded")}
							value={String(data.summary.rewarded)}
							icon="check-circle"
						/>
						<Metric
							label={t("settings.referrals.earned")}
							value={formatUsd(data.summary.earnedUsd)}
							icon="gift"
						/>
					</View>
					<SectionHeader title={t("settings.referrals.recent")} />
					<SettingsGroup>
						{data.items.slice(0, 12).map((item) => (
							<SettingsRow
								key={item.id}
								icon="user"
								title={item.profile?.displayName || t("settings.profile.fallbackName")}
								detail={formatRelativeTime(item.claimedAt)}
								trailing={
									<StatusPill
										label={item.status}
										tone={item.status === "rewarded" ? "success" : "neutral"}
									/>
								}
							/>
						))}
						{data.items.length === 0 ? (
							<Text
								style={[
									typography.body,
									{ color: theme.colors.textMuted, padding: 16 },
								]}
							>
								{t("settings.referrals.none")}
							</Text>
						) : null}
					</SettingsGroup>
				</>
			)}
		</View>
	);
}

function Metric({
	label,
	value,
	icon,
}: {
	label: string;
	value: string;
	icon: React.ComponentProps<typeof AppIcon>["name"];
}) {
	const theme = useAppTheme();
	return (
		<View
			style={{
				flex: 1,
				minHeight: 78,
				padding: 11,
				borderWidth: 1,
				borderColor: theme.colors.border,
				borderRadius: 12,
				backgroundColor: theme.colors.surface,
			}}
		>
			<AppIcon name={icon} size={16} color={theme.colors.accent} />
			<Text
				numberOfLines={1}
				style={[typography.heading, { color: theme.colors.text, marginTop: 8 }]}
			>
				{value}
			</Text>
			<Text
				style={[
					typography.micro,
					{ color: theme.colors.textMuted, marginTop: 2 },
				]}
			>
				{label}
			</Text>
		</View>
	);
}

function LoadingBlock() {
	const theme = useAppTheme();
	const { t } = useTranslation();
	return (
		<View
			style={{ minHeight: 190, alignItems: "center", justifyContent: "center" }}
		>
			<ActivityIndicator size="small" color={theme.colors.accent} />
			<Text
				style={[
					typography.caption,
					{ color: theme.colors.textMuted, marginTop: 10 },
				]}
			>
				{t("settings.loading")}
			</Text>
		</View>
	);
}

function InlineError({
	message,
	onRetry,
}: {
	message: string;
	onRetry: () => void;
}) {
	const theme = useAppTheme();
	const { t } = useTranslation();
	return (
		<View
			style={{
				marginHorizontal: 16,
				marginTop: 13,
				padding: 14,
				borderWidth: 1,
				borderColor: theme.colors.danger,
				borderRadius: 12,
				backgroundColor: theme.colors.dangerSoft,
			}}
		>
			<Text
				selectable
				style={[typography.caption, { color: theme.colors.danger }]}
			>
				{message}
			</Text>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={t("common.retry")}
				onPress={onRetry}
				style={({ pressed }) => ({
					marginTop: 10,
					alignSelf: "flex-start",
					opacity: pressed ? 0.6 : 1,
				})}
			>
				<Text style={[typography.bodyMedium, { color: theme.colors.danger }]}>
					{t("common.retry")}
				</Text>
			</Pressable>
		</View>
	);
}

function formatUsd(value: number) {
	if (!Number.isFinite(value)) return "$0.00";
	return `$${value.toFixed(2)}`;
}

const styles = {
	input: {
		minHeight: 48,
		borderWidth: 1,
		borderRadius: 10,
		paddingHorizontal: 12,
	},
} satisfies Record<string, object>;
