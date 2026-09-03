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
import { AboutContent } from "@/src/components/AboutScreen";
import { AdaptiveSheet } from "@/src/components/AdaptiveSheet";
import { AppearanceContent } from "@/src/components/AppearanceScreen";
import { useProfileSession } from "@/src/auth/profile-session";
import { useApp } from "@/src/data/context";
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
	| "appearance"
	| "about"
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
	label: string;
	icon: React.ComponentProps<typeof AppIcon>["name"];
}[] = [
	{ id: "profile", label: "Profile", icon: "user" },
	{ id: "appearance", label: "Appearance", icon: "palette" },
	{ id: "about", label: "About", icon: "info" },
	{ id: "activity", label: "Activity", icon: "activity" },
	{ id: "notifications", label: "Notifications", icon: "bell" },
	{ id: "rules", label: "Rules", icon: "file-text" },
	{ id: "channels", label: "Channels", icon: "messages" },
	{ id: "billing", label: "Billing", icon: "database" },
	{ id: "referrals", label: "Referrals", icon: "share" },
];

export function SettingsScreen({
	initialSection = "profile",
}: SettingsScreenProps) {
	const router = useRouter();
	const theme = useAppTheme();
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
					title: "Local cache cleanup incomplete",
					message:
						error instanceof Error
							? `${error.message} Sign out will continue.`
							: "Local cache could not be cleared. Sign out will continue.",
				});
			}
			await signOut();
			setSignOutOpen(false);
		} catch (error) {
			setNotice({
				title: "Sign out failed",
				message: error instanceof Error ? error.message : "Unable to sign out.",
			});
		} finally {
			setSigningOut(false);
		}
	};

	return (
		<Screen>
			<DetailTopBar
				title="Settings"
				subtitle="Account, app, and workspace preferences"
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
					return (
						<Pressable
							key={item.id}
							accessibilityRole="tab"
							accessibilityState={{ selected: active }}
							accessibilityLabel={item.label}
							onPress={() => setSection(item.id)}
							android_ripple={{ color: theme.colors.pressOverlay }}
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
								{item.label}
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
				{section === "appearance" ? <AppearanceSection /> : null}
				{section === "about" ? <AboutSection onNotice={setNotice} /> : null}
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
						accessibilityLabel="Sign out"
						onPress={() => setSignOutOpen(true)}
						android_ripple={{ color: theme.colors.dangerSoft }}
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
							{signingOut ? "Signing out" : "Sign out"}
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
				title={notice?.title ?? "Notice"}
				onClose={() => setNotice(null)}
				scrollable={false}
				footer={
					<View style={{ alignItems: "flex-end" }}>
						<PrimaryButton
							label="Done"
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
				title="Sign out of Cohub?"
				subtitle="Your cached work on this device will be cleared."
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
								Cancel
							</Text>
						</Pressable>
						<PrimaryButton
							label="Sign out"
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
					Work stored in your Spaces will not be changed.
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
			android_ripple={{ color: theme.colors.pressOverlay }}
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
			setError("Connect to Cohub to load account settings.");
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
				caught instanceof Error ? caught.message : "Unable to load profile",
			);
		} finally {
			setLoading(false);
		}
	}, [client, getClaims]);

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
					title: "Photo access is off",
					message:
						"Allow photo access in system settings to change your avatar.",
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
				mimeType: asset.mimeType || "image/jpeg",
				filename: asset.fileName || "avatar.jpg",
			});
			const updated = await client.user.updateProfile({
				avatarUrl: uploaded.publicUrl,
			});
			setData((current) => ({ ...current, profile: updated.profile }));
			onNotice({
				title: "Avatar updated",
				message: "Your new avatar is now visible across Cohub.",
			});
		} catch (caught) {
			setError(
				caught instanceof Error ? caught.message : "Unable to update avatar",
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
				title: "Profile updated",
				message: "Your account profile has been saved.",
			});
		} catch (caught) {
			setError(
				caught instanceof Error ? caught.message : "Unable to save profile",
			);
		} finally {
			setSaving(false);
		}
	};

	return (
		<View>
			<SettingsIntro
				title="Profile"
				description="Manage the identity shown across your Cohub account."
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
							accessibilityLabel="Change avatar"
							onPress={() => void changeAvatar()}
							disabled={uploadingAvatar}
							style={({ pressed }) => ({
								borderRadius: 28,
								opacity: pressed || uploadingAvatar ? 0.65 : 1,
							})}
						>
							<Avatar
								name={data.profile?.displayName || "Cohub user"}
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
									Uploading avatar
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
							{data.profile?.displayName || "Cohub user"}
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
							Tap the avatar to change it
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
								Display name
							</Text>
							<TextInput
								value={displayName}
								onChangeText={setDisplayName}
								maxLength={120}
								placeholder="Your name"
								placeholderTextColor={theme.colors.textFaint}
								style={[
									styles.input,
									{
										color: theme.colors.text,
										borderColor: theme.colors.border,
										backgroundColor: theme.colors.background,
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
								Username
							</Text>
							<TextInput
								value={username}
								onChangeText={setUsername}
								maxLength={39}
								autoCapitalize="none"
								placeholder="your-handle"
								placeholderTextColor={theme.colors.textFaint}
								style={[
									styles.input,
									{
										color: theme.colors.text,
										borderColor: theme.colors.border,
										backgroundColor: theme.colors.background,
									},
								]}
							/>
							<PrimaryButton
								label={saving ? "Saving" : "Save changes"}
								icon="check"
								loading={saving}
								disabled={!displayName.trim()}
								onPress={() => void save()}
								style={{ marginTop: 15 }}
							/>
						</View>
					</SettingsGroup>
					<SectionHeader title="Account identity" />
					<SettingsGroup>
						<SettingsRow
							icon="fingerprint"
							title="User ID"
							detail={data.uuid || "Unavailable"}
							trailing={null}
						/>
						<SettingsRow
							icon="user"
							title="Username"
							detail={username ? `@${username}` : "Not set"}
							trailing={null}
						/>
					</SettingsGroup>
				</>
			)}
		</View>
	);
}

function AppearanceSection() {
	return <AppearanceContent />;
}

function AboutSection({ onNotice }: { onNotice: (notice: { title: string; message: string }) => void }) {
	return <AboutContent onNotice={onNotice} />;
}

function ActivitySection({ client }: { client: CohubClient | null }) {
	const theme = useAppTheme();
	const [days, setDays] = useState(30);
	const [data, setData] = useState<UserActivityResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const load = useCallback(async () => {
		if (!client) {
			setLoading(false);
			setError("Connect to Cohub to load activity.");
			return;
		}
		setLoading(true);
		setError(null);
		try {
			setData(await client.user.getActivity({ days }));
		} catch (caught) {
			setError(
				caught instanceof Error ? caught.message : "Unable to load activity",
			);
		} finally {
			setLoading(false);
		}
	}, [client, days]);
	useEffect(() => {
		void Promise.resolve().then(() => load());
	}, [load]);
	const summary = data?.summary;
	return (
		<View>
			<SettingsIntro
				title="Activity"
				description="Review recent usage across your Chats, models, and Works."
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
							{value === 365 ? "1Y" : `${value}D`}
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
							label="Tokens"
							value={formatNumber(summary?.totalTokens)}
							icon="layers"
						/>
						<Metric
							label="Requests"
							value={formatNumber(summary?.requestCount)}
							icon="zap"
						/>
						<Metric
							label="Success"
							value={formatNumber(summary?.successCount)}
							icon="check-circle"
						/>
					</View>
					<SectionHeader title="Top models" />
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
								No model usage in this period.
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
					title: "Notifications enabled",
					message:
						"This device is registered to receive Agent completion notifications.",
				});
			else
				onNotice({ title: "Notifications unavailable", message: next.message });
		} catch (error) {
			onNotice({
				title: "Notifications unavailable",
				message:
					error instanceof Error
						? error.message
						: "Unable to configure notifications.",
			});
		} finally {
			setLoading(false);
		}
	};
	const status =
		result?.status === "enabled"
			? "Enabled"
			: result?.status === "unavailable"
				? "Needs setup"
				: "Not configured";
	return (
		<View>
			<SettingsIntro
				title="Notifications"
				description="Get a notification when Agent work finishes while Cohub is not in front."
			/>
			<SettingsGroup>
				<SettingsRow
					icon="bell"
					title="Agent completion notifications"
					detail={
						result?.message ??
						"Permission, device registration, and server delivery are checked together."
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
						label={loading ? "Checking device" : "Enable notifications"}
						icon="bell"
						loading={loading}
						onPress={() => void enable()}
						style={{ minHeight: 46 }}
					/>
					{result?.status === "unavailable" &&
					result.reason === "permission-denied" ? (
						<Pressable
							accessibilityRole="button"
							accessibilityLabel="Open system notification settings"
							onPress={() => void Linking.openSettings()}
							style={({ pressed }) => ({
								marginTop: 11,
								opacity: pressed ? 0.6 : 1,
							})}
						>
							<Text
								style={[typography.bodyMedium, { color: theme.colors.accent }]}
							>
								Open system settings
							</Text>
						</Pressable>
					) : null}
					<Text
						style={[
							typography.caption,
							{ color: theme.colors.textMuted, marginTop: 10 },
						]}
					>
						Android requires a formal development/release build with Firebase
						configuration. Expo Go cannot provide remote push tokens.
					</Text>
				</View>
			</SettingsGroup>
			<SectionHeader title="Device" />
			<SettingsGroup>
				<SettingsRow
					icon="fingerprint"
					title="Installation"
					detail={
						installationId
							? `${installationId.slice(0, 8)}…`
							: "Preparing device identity"
					}
				/>
				<SettingsRow
					icon="wifi"
					title="Delivery"
					detail={
						client ? "Connected to Cohub API" : "Waiting for account connection"
					}
				/>
			</SettingsGroup>
		</View>
	);
}

function RulesSection({ client }: { client: CohubClient | null }) {
	const theme = useAppTheme();
	const [data, setData] = useState<UserRulesResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const load = useCallback(async () => {
		if (!client) {
			setLoading(false);
			setError("Connect to Cohub to load user rules.");
			return;
		}
		setLoading(true);
		setError(null);
		try {
			setData(await client.user.getRules());
		} catch (caught) {
			setError(
				caught instanceof Error ? caught.message : "Unable to load rules",
			);
		} finally {
			setLoading(false);
		}
	}, [client]);
	useEffect(() => {
		void Promise.resolve().then(() => load());
	}, [load]);
	return (
		<View>
			<SettingsIntro
				title="User rules"
				description="Read the AGENTS.md rules that shape your personal Cohub sessions."
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
								? `Updated ${formatRelativeTime(data.updatedAt)}`
								: "Not published yet"}
						</Text>
						<ScrollView
							horizontal={false}
							style={{ maxHeight: 360, marginTop: 13 }}
						>
							<Text
								selectable
								style={{
									color: theme.colors.textSecondary,
									fontFamily: "SpaceMono",
									fontSize: 12,
									lineHeight: 19,
								}}
							>
								{data?.content?.trim() || "No published user rules."}
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
	const [channels, setChannels] = useState<Channel[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [removeCandidate, setRemoveCandidate] = useState<Channel | null>(null);
	const [removing, setRemoving] = useState(false);
	const load = useCallback(async () => {
		if (!client) {
			setLoading(false);
			setError("Connect to Cohub to load channels.");
			return;
		}
		setLoading(true);
		setError(null);
		try {
			setChannels(await client.channels.list());
		} catch (caught) {
			setError(
				caught instanceof Error ? caught.message : "Unable to load channels",
			);
		} finally {
			setLoading(false);
		}
	}, [client]);
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
				title: "Channel could not be removed",
				message:
					caught instanceof Error
						? caught.message
						: "Unable to remove channel.",
			});
		} finally {
			setRemoving(false);
		}
	};
	return (
		<View>
			<SettingsIntro
				title="Channels"
				description="Review connected chat channels and their current binding state."
			/>
			{loading ? (
				<LoadingBlock />
			) : error ? (
				<InlineError message={error} onRetry={() => void load()} />
			) : channels.length === 0 ? (
				<EmptyState
					icon="messages"
					title="No channels"
					description="Connected Discord, Feishu, WeChat, and other channels will appear here."
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
											? `Bound to ${channel.boundSpace.title || channel.boundSpace.id.slice(0, 8)}`
											: "Not bound"}
									</Text>
								</View>
								{!channel.boundSpace ? (
									<IconButton
										name="trash"
										label={`Remove ${channel.name}`}
										tone="danger"
										size={38}
										onPress={() => setRemoveCandidate(channel)}
									/>
								) : (
									<StatusPill label="Bound" tone="success" />
								)}
							</View>
						))}
					</SettingsGroup>
					<AdaptiveSheet
						visible={removeCandidate !== null}
						title="Remove channel?"
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
										Cancel
									</Text>
								</Pressable>
								<PrimaryButton
									label="Remove"
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
							This only removes the channel connection. A bound channel must be
							unbound from its Space first.
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
	const [credits, setCredits] = useState<BillingCreditStatus | null>(null);
	const [catalog, setCatalog] = useState<BillingCatalog | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [pendingProductKey, setPendingProductKey] = useState<string | null>(null);
	const load = useCallback(async () => {
		if (!client) {
			setLoading(false);
			setError("Connect to Cohub to load billing.");
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
				caught instanceof Error ? caught.message : "Unable to load billing",
			);
		} finally {
			setLoading(false);
		}
	}, [client]);
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
					title: "Checkout unavailable",
					message:
						checkout.message ||
						"This billing provider is not ready for this account.",
				});
				return;
			}
			await WebBrowser.openBrowserAsync(checkout.checkoutUrl);
		} catch (caught) {
			onNotice({
				title: "Checkout unavailable",
				message:
					caught instanceof Error ? caught.message : "Unable to open checkout.",
			});
		} finally {
			setPendingProductKey(null);
		}
	};
	return (
		<View>
			<SettingsIntro
				title="Billing"
				description="View your Cohub balance and available plans."
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
								Current balance
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
					<SectionHeader title="Plans" />
					<SettingsGroup>
						{(catalog?.plans ?? []).slice(0, 8).map((plan) => (
							<SettingsRow
								key={plan.key}
								icon="zap"
								title={plan.name}
								detail={plan.description || "Cohub plan"}
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
								No plans are available.
							</Text>
						) : null}
					</SettingsGroup>
					{(catalog?.addons ?? []).length > 0 ? (
						<>
							<SectionHeader title="Credit packages" />
							<SettingsGroup>
								{(catalog?.addons ?? []).slice(0, 8).map((addon) => (
									<SettingsRow
										key={addon.key}
										icon="zap"
										title={addon.name}
										detail={addon.description || "Additional Cohub credits"}
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
	const [data, setData] = useState<ReferralDashboard | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const load = useCallback(async () => {
		if (!client) {
			setLoading(false);
			setError("Connect to Cohub to load referrals.");
			return;
		}
		setLoading(true);
		setError(null);
		try {
			setData(await client.referrals.getMine());
		} catch (caught) {
			setError(
				caught instanceof Error ? caught.message : "Unable to load referrals",
			);
		} finally {
			setLoading(false);
		}
	}, [client]);
	useEffect(() => {
		void Promise.resolve().then(() => load());
	}, [load]);
	const share = async () => {
		if (!data) return;
		const url = `https://cohub.live/referrals/${data.code}`;
		try {
			await Share.share({ title: "Join Cohub", message: url });
		} catch {
			onNotice({
				title: "Share unavailable",
				message: "The referral link is ready to copy from the Cohub web app.",
			});
		}
	};
	return (
		<View>
			<SettingsIntro
				title="Referrals"
				description="Share Cohub with someone and track earned credits."
			/>
			{loading ? (
				<LoadingBlock />
			) : error || !data ? (
				<InlineError
					message={error || "Referral data is unavailable"}
					onRetry={() => void load()}
				/>
			) : (
				<>
					<SettingsGroup>
						<View style={{ padding: 15 }}>
							<Text
								style={[typography.caption, { color: theme.colors.textMuted }]}
							>
								Your referral link
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
								label="Share link"
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
							label="Rewarded"
							value={String(data.summary.rewarded)}
							icon="check-circle"
						/>
						<Metric
							label="Earned"
							value={formatUsd(data.summary.earnedUsd)}
							icon="gift"
						/>
					</View>
					<SectionHeader title="Recent referrals" />
					<SettingsGroup>
						{data.items.slice(0, 12).map((item) => (
							<SettingsRow
								key={item.id}
								icon="user"
								title={item.profile?.displayName || "Cohub user"}
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
								No referrals yet.
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
				Loading settings
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
				accessibilityLabel="Retry"
				onPress={onRetry}
				style={({ pressed }) => ({
					marginTop: 10,
					alignSelf: "flex-start",
					opacity: pressed ? 0.6 : 1,
				})}
			>
				<Text style={[typography.bodyMedium, { color: theme.colors.danger }]}>
					Retry
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
		fontSize: 15,
	},
} satisfies Record<string, object>;
