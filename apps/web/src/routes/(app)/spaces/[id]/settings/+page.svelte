<script lang="ts">
import {
	type DefaultSpaceModDefinition,
	getDefaultSpaceModsForEnv,
	isWorkspaceUsage,
	normalizeCohubRuntimeEnv,
	WORKSPACE_USAGE_UPDATED_EVENT,
} from "@cohub/protocol";
import type {
	AppRecord,
	Channel,
	DiscordChannelConfig,
	FeishuChannelConfig,
	SpaceAccessPolicy,
	SpaceChannelBindingRecord,
	SpaceEnvInput,
	SpaceMember,
	SpaceModListItem,
	SpaceRecord,
	SpaceRole,
} from "@neta-art/cohub";
import {
	ArrowLeft,
	Check,
	Copy,
	Eye,
	EyeOff,
	Globe,
	Link,
	Loader2,
	Network,
	PackagePlus,
	Pencil,
	Plus,
	RefreshCw,
	Settings,
	Terminal,
	Trash2,
	Upload,
	Users,
	Wallet,
	X,
} from "lucide-svelte";
import { onDestroy, untrack } from "svelte";
import { browser } from "$app/environment";
import { goto } from "$app/navigation";
import { PUBLIC_COHUB_ENV } from "$env/static/public";
import { appDisplayTitle } from "$lib/app-page-meta";
import {
	channelHealthClass,
	channelHealthDetail,
	channelHealthLabel,
	channelHealthMessage,
} from "$lib/channel-health";
import { copyTextToClipboard } from "$lib/clipboard";
import ChannelModelPicker from "$lib/components/ChannelModelPicker.svelte";
import FilterBar from "$lib/components/list-page/FilterBar.svelte";
import FilterChip from "$lib/components/list-page/FilterChip.svelte";
import HeaderAction from "$lib/components/list-page/HeaderAction.svelte";
import ListHeader from "$lib/components/list-page/ListHeader.svelte";
import ListRowText from "$lib/components/list-page/ListRowText.svelte";
import { LIST_ROW_AVATAR } from "$lib/components/list-page/list-row";
import Sheet from "$lib/components/Sheet.svelte";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import UploadProgress from "$lib/components/UploadProgress.svelte";
import UserAvatar from "$lib/components/UserAvatar.svelte";
import { subscribeSpaceChannel } from "$lib/features/session-chat/space-channel";
import SandboxSettings from "$lib/features/space-settings/SandboxSettings.svelte";
import SettingsHeading from "$lib/features/space-settings/SettingsHeading.svelte";
import SettingsRow, {
	SETTINGS_SELECT,
} from "$lib/features/space-settings/SettingsRow.svelte";
import SpaceInvitations from "$lib/features/space-settings/SpaceInvitations.svelte";
import { SandboxSettingsState } from "$lib/features/space-settings/sandbox-settings.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { isComposingKeyboardEvent } from "$lib/keyboard";
import { m } from "$lib/paraglide/messages.js";
import { uploadSpaceAvatarImage } from "$lib/public-asset-images";
import { sdk } from "$lib/sdk";
import { validateSpaceSlugInput } from "$lib/slug-rules";
import { buildSpaceLandingRoute } from "$lib/space-routes";
import { invalidateCachedSpaceMembers } from "$lib/stores/space-profile-cache";
import { cacheSpaceRecordSoon } from "$lib/stores/space-record-cache";

const locale = $derived(getLocale());
const props = $props<{ data: { spaceId: string } }>();
const spaceId = $derived(props.data.spaceId);
const sandboxSettings = $derived(new SandboxSettingsState(spaceId));
const recommendedBaseMod =
	getDefaultSpaceModsForEnv(normalizeCohubRuntimeEnv(PUBLIC_COHUB_ENV))[0] ??
	null;

let space = $state<SpaceRecord | null>(null);
let access = $state<SpaceAccessPolicy | null>(null);
let members = $state<SpaceMember[]>([]);
let guestApps = $state<AppRecord[]>([]);
let env = $state<SpaceEnvInput[]>([]);
let channels = $state<SpaceChannelBindingRecord[]>([]);
let mods = $state<SpaceModListItem[]>([]);
let allChannels = $state<Channel[]>([]);
let loading = $state(true);
let error = $state("");
let envName = $state("");
let envValue = $state("");
let selectedChannelId = $state("");
let savingChannelConfigIds = $state<Set<string>>(new Set());
let modSpaceId = $state("");
let modName = $state("");
let modMountSlug = $state("");
let modError = $state("");
let modSaving = $state(false);
let modUpdatingId = $state<string | null>(null);
let modRestartMessage = $state("");
let modRestartTimer: ReturnType<typeof setTimeout> | null = null;
let copiedModSpaceId = $state<string | null>(null);
let copiedModSpaceIdTimer: ReturnType<typeof setTimeout> | null = null;
let revealedEnvNames = $state<Set<string>>(new Set());
let copiedMemberUserId = $state<string | null>(null);
let copiedMemberTimer: ReturnType<typeof setTimeout> | null = null;
let addingMemberUuid = $state("");
let addingMemberRole = $state<SpaceRole>("guest");
let savingMember = $state(false);
let accessError = $state("");
let envError = $state("");
let channelError = $state("");
let channelHealthRefreshTimer: ReturnType<typeof setInterval> | null = null;
let addingMemberError = $state("");
let updatingMemberUserId = $state<string | null>(null);
let removingMemberUserId = $state<string | null>(null);
let showInvitePanel = $state(false);
let renamingSpace = $state(false);
let renameInput = $state("");
let renameSaving = $state(false);
let renameError = $state("");
let spaceDescriptionDraft = $state("");
let spaceDescriptionSaving = $state(false);
let spaceProfileError = $state("");
let spaceAvatarUploading = $state(false);
let spaceAvatarUploadStage = $state<
	"idle" | "preparing" | "uploading" | "saving"
>("idle");
let spaceAvatarUploadProgress = $state(0);
let editingSpaceSlug = $state(false);
let spaceSlugDraft = $state("");
let spaceSlugSaving = $state(false);
let spaceSlugError = $state("");
let copiedSpaceId = $state(false);
let copiedSpaceIdTimer: ReturnType<typeof setTimeout> | null = null;
let copiedSpaceSlugLink = $state(false);
let copiedSpaceSlugLinkTimer: ReturnType<typeof setTimeout> | null = null;
const shouldShowBaseModRecommendation = $derived(
	recommendedBaseMod
		? !mods.some((mod) => mod.modSpaceId === recommendedBaseMod.modSpaceId)
		: false,
);
const canEditSpaceProfile = $derived(
	space?.access?.permissions.includes("space.edit") === true,
);
const canManageSpaceMembers = $derived(
	space?.access?.permissions.includes("member.manage") === true,
);
const canManageSpaceChannels = $derived(
	space?.access?.permissions.includes("channel.manage") === true,
);
const canManageSpaceMods = $derived(
	space?.access?.permissions.includes("mod.manage") === true,
);
const canManageSpaceSandbox = $derived(
	space?.access?.permissions.includes("sandbox.manage") === true,
);
const memberRoleOptions = $derived([
	{ value: "guest", label: m.space_role_guest({}, { locale }) },
	{ value: "builder", label: m.space_role_builder({}, { locale }) },
	{ value: "host", label: m.space_role_host({}, { locale }) },
]);

onDestroy(() => {
	if (modRestartTimer) clearTimeout(modRestartTimer);
	if (copiedModSpaceIdTimer) clearTimeout(copiedModSpaceIdTimer);
	if (copiedMemberTimer) clearTimeout(copiedMemberTimer);
	if (copiedSpaceIdTimer) clearTimeout(copiedSpaceIdTimer);
	if (copiedSpaceSlugLinkTimer) clearTimeout(copiedSpaceSlugLinkTimer);
	if (programmaticScrollTimer) clearTimeout(programmaticScrollTimer);
	if (channelHealthRefreshTimer) clearInterval(channelHealthRefreshTimer);
	if (scrollSpyRaf) cancelAnimationFrame(scrollSpyRaf);
	scrollSpyObserver?.disconnect();
});

$effect(() => {
	const id = spaceId;
	const settings = sandboxSettings;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const stop = sdk.onUserEvent((event) => {
		if (
			event.type !== "space.list.changed" ||
			(event.payload as { spaceId?: string }).spaceId !== id
		)
			return;
		clearTimeout(timer);
		timer = setTimeout(() => void settings.load(), 100);
	});
	return () => {
		stop();
		clearTimeout(timer);
	};
});

function goBack() {
	if (window.history.length > 1) {
		window.history.back();
		return;
	}
	void goto(buildSpaceLandingRoute(spaceId));
}

function getSpaceOwnerUsername(record: SpaceRecord | null): string {
	return record?.ownerProfile?.username?.trim() ?? "";
}

function getSpaceSlug(record: SpaceRecord | null): string {
	return record?.slug?.trim() ?? "";
}

function getSpacePublicPath(record: SpaceRecord | null): string {
	const username = getSpaceOwnerUsername(record);
	const slug = getSpaceSlug(record);
	return username && slug ? `/${username}/${slug}` : "";
}

function getSpacePrettyUrlHint(record: SpaceRecord | null): string {
	const hasUsername = Boolean(getSpaceOwnerUsername(record));
	const hasSlug = Boolean(getSpaceSlug(record));
	if (hasUsername && hasSlug) return "";
	if (!hasUsername && !hasSlug) return m.space_slug_hint_user({}, { locale });
	if (!hasUsername) return m.space_slug_hint_profile({}, { locale });
	return m.space_slug_hint({}, { locale });
}

function formatCompactId(id: string): string {
	if (!id) return "";
	if (id.length <= 13) return id;
	return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

async function handleRenameSpace(newName: string) {
	renameSaving = true;
	renameError = "";
	try {
		const result = await sdk.space(spaceId).rename(newName);
		space = result.space;
		cacheSpaceRecordSoon(result.space);
		renamingSpace = false;
	} catch (err) {
		renameError =
			err instanceof Error
				? err.message
				: m.space_failed_rename({}, { locale });
	} finally {
		renameSaving = false;
	}
}

function beginSpaceSlugEdit() {
	if (!canEditSpaceProfile || spaceSlugSaving) return;
	spaceSlugDraft = space?.slug ?? "";
	spaceSlugError = "";
	editingSpaceSlug = true;
}

function cancelSpaceSlugEdit() {
	if (spaceSlugSaving) return;
	editingSpaceSlug = false;
	spaceSlugDraft = "";
	spaceSlugError = "";
}

function handleSpaceSlugKeydown(event: KeyboardEvent) {
	if (event.key === "Escape") {
		event.preventDefault();
		cancelSpaceSlugEdit();
		return;
	}
	if (event.key === "Enter" && !isComposingKeyboardEvent(event)) {
		event.preventDefault();
		void saveSpaceSlug();
	}
}

async function saveSpaceSlug() {
	if (!space || spaceSlugSaving) return;
	spaceSlugError = "";
	const result = validateSpaceSlugInput(spaceSlugDraft, {
		currentValue: space.slug,
	});
	if (result.error) {
		spaceSlugError = result.error;
		return;
	}
	const nextSlug = result.value;
	if (nextSlug === space.slug) {
		editingSpaceSlug = false;
		return;
	}
	spaceSlugSaving = true;
	try {
		const updateResult = await sdk.space(spaceId).update({ slug: nextSlug });
		space = updateResult.space;
		cacheSpaceRecordSoon(updateResult.space);
		editingSpaceSlug = false;
		spaceSlugDraft = "";
	} catch (err) {
		spaceSlugError =
			err instanceof Error ? err.message : m.space_failed_slug({}, { locale });
	} finally {
		spaceSlugSaving = false;
	}
}

async function copySpaceId() {
	try {
		await copyTextToClipboard(spaceId);
		copiedSpaceId = true;
		if (copiedSpaceIdTimer) clearTimeout(copiedSpaceIdTimer);
		copiedSpaceIdTimer = setTimeout(() => {
			copiedSpaceId = false;
		}, 2000);
	} catch {}
}

async function copySpacePublicLink() {
	const path = getSpacePublicPath(space);
	if (!path) return;
	try {
		await copyTextToClipboard(`${window.location.origin}${path}`);
		copiedSpaceSlugLink = true;
		if (copiedSpaceSlugLinkTimer) clearTimeout(copiedSpaceSlugLinkTimer);
		copiedSpaceSlugLinkTimer = setTimeout(() => {
			copiedSpaceSlugLink = false;
		}, 2000);
	} catch {}
}

async function saveSpaceDescription() {
	if (spaceDescriptionSaving) return;
	spaceDescriptionSaving = true;
	spaceProfileError = "";
	try {
		const result = await sdk.space(spaceId).profile({
			description: spaceDescriptionDraft.trim() || null,
		});
		space = result.space;
		cacheSpaceRecordSoon(result.space);
	} catch (err) {
		spaceProfileError =
			err instanceof Error
				? err.message
				: m.space_failed_profile({}, { locale });
	} finally {
		spaceDescriptionSaving = false;
	}
}

function handleDescriptionKeydown(event: KeyboardEvent) {
	if (
		(event.metaKey || event.ctrlKey) &&
		event.key === "Enter" &&
		!isComposingKeyboardEvent(event)
	) {
		event.preventDefault();
		void saveSpaceDescription();
	}
}

async function uploadSpaceAvatar(file: File) {
	if (!canEditSpaceProfile || spaceAvatarUploading) return;
	spaceAvatarUploading = true;
	spaceAvatarUploadStage = "preparing";
	spaceAvatarUploadProgress = 0;
	spaceProfileError = "";
	try {
		const asset = await uploadSpaceAvatarImage({
			spaceId,
			file,
			onProgress: ({ ratio }) => {
				spaceAvatarUploadStage = "uploading";
				spaceAvatarUploadProgress = Math.round(ratio * 100);
			},
		});
		spaceAvatarUploadStage = "saving";
		const result = await sdk.space(spaceId).profile({
			description: space?.description ?? null,
			avatarUrl: asset.publicUrl,
		});
		space = result.space;
		cacheSpaceRecordSoon(result.space);
	} catch (err) {
		spaceProfileError =
			err instanceof Error
				? err.message
				: m.space_failed_avatar({}, { locale });
	} finally {
		spaceAvatarUploading = false;
		spaceAvatarUploadStage = "idle";
		spaceAvatarUploadProgress = 0;
	}
}

function handleSpaceAvatarFileChange(event: Event) {
	const input = event.currentTarget as HTMLInputElement;
	const file = input.files?.[0];
	input.value = "";
	if (file) void uploadSpaceAvatar(file);
}

function confirmModRestart(): boolean {
	return window.confirm(m.space_mod_restart_confirm({}, { locale }));
}

function noteModRestart() {
	modRestartMessage = m.space_mod_restarting({}, { locale });
	if (modRestartTimer) clearTimeout(modRestartTimer);
	modRestartTimer = setTimeout(() => {
		modRestartMessage = "";
	}, 6000);
}

async function loadPage() {
	loading = true;
	error = "";
	try {
		const spacePromise = sdk.space(spaceId).get();
		const [
			spaceResult,
			accessResult,
			memberResult,
			envResult,
			channelResult,
			modResult,
			allChannelResult,
			appResult,
		] = await Promise.all([
			spacePromise,
			sdk
				.space(spaceId)
				.access.get()
				.catch(() => null),
			sdk
				.space(spaceId)
				.members.list()
				.catch(() => ({ items: [] })),
			sdk
				.space(spaceId)
				.env.list()
				.catch(() => ({ env: [] })),
			sdk
				.space(spaceId)
				.channels.list()
				.catch(() => []),
			sdk
				.space(spaceId)
				.mods.list()
				.catch(() => ({ items: [] })),
			sdk.channels.list().catch(() => []),
			sdk.apps.listBySpace(spaceId).catch(() => ({ apps: [] })),
			sandboxSettings.load(),
		]);
		space = spaceResult;
		spaceDescriptionDraft = spaceResult.description ?? "";
		cacheSpaceRecordSoon(spaceResult);
		access = accessResult;
		members = memberResult.items;
		env = envResult.env;
		channels = channelResult;
		mods = modResult.items;
		allChannels = allChannelResult;
		guestApps = appResult.apps.filter(
			(app) => app.status === "published" && app.visibility === "public",
		);
		if (channelHealthRefreshTimer) clearInterval(channelHealthRefreshTimer);
		channelHealthRefreshTimer = setInterval(() => {
			void refreshChannelHealth();
		}, 15_000);
	} catch (err) {
		error =
			err instanceof Error ? err.message : m.space_failed_load({}, { locale });
	} finally {
		loading = false;
	}
}

async function refreshChannelHealth() {
	if (loading) return;
	try {
		const channelResult = await sdk.space(spaceId).channels.list();
		channels = channelResult;
	} catch {}
}

async function setAccess(body: {
	signed_in_user?: SpaceRole | null;
	anonymous_user?: SpaceRole | null;
}) {
	if (!canManageSpaceMembers) return;
	accessError = "";
	try {
		access = await sdk.space(spaceId).access.set(body);
	} catch (err) {
		accessError =
			err instanceof Error
				? err.message
				: m.space_failed_access({}, { locale });
	}
}

async function setGuestApp(appId: string) {
	if (!canEditSpaceProfile) return;
	accessError = "";
	try {
		const result = await sdk
			.space(spaceId)
			.updateConfig({ guest: appId ? { appId } : null });
		space = result.space;
		cacheSpaceRecordSoon(result.space);
	} catch (err) {
		accessError =
			err instanceof Error
				? err.message
				: m.space_failed_access({}, { locale });
	}
}

async function addEnv() {
	if (!canEditSpaceProfile || !envName.trim()) return;
	envError = "";
	try {
		const result = await sdk
			.space(spaceId)
			.env.create({ name: envName.trim(), value: envValue });
		env = result.env;
		envName = "";
		envValue = "";
	} catch (err) {
		envError =
			err instanceof Error
				? err.message
				: m.space_failed_var_add({}, { locale });
	}
}

async function removeEnv(name: string) {
	if (!canEditSpaceProfile) return;
	envError = "";
	try {
		const result = await sdk.space(spaceId).env.remove(name);
		env = result.env;
	} catch (err) {
		envError =
			err instanceof Error
				? err.message
				: m.space_failed_var_remove({}, { locale });
	}
}

function toggleEnvReveal(name: string) {
	const next = new Set(revealedEnvNames);
	if (next.has(name)) next.delete(name);
	else next.add(name);
	revealedEnvNames = next;
}

async function loadMembers() {
	const result = await sdk.space(spaceId).members.list();
	members = result.items;
}

async function addMember() {
	if (!canManageSpaceMembers || !addingMemberUuid.trim() || savingMember)
		return;
	savingMember = true;
	addingMemberError = "";
	try {
		await sdk
			.space(spaceId)
			.members.update(addingMemberUuid.trim(), addingMemberRole);
		invalidateCachedSpaceMembers(spaceId);
		addingMemberUuid = "";
		await loadMembers();
	} catch (err) {
		addingMemberError =
			err instanceof Error
				? err.message
				: m.space_failed_member_add({}, { locale });
	} finally {
		savingMember = false;
	}
}

function getMemberDisplayName(member: SpaceMember): string {
	return member.profile?.displayName?.trim() || m.space_user({}, { locale });
}

function getMemberRoleIcon(role: SpaceRole) {
	if (role === "host") return "👑";
	return null;
}

function getMemberUuid(member: SpaceMember): string {
	return member.profile?.userUuid ?? member.userId;
}

async function copyMemberUuid(member: SpaceMember) {
	const value = getMemberUuid(member);
	try {
		await copyTextToClipboard(value);
		copiedMemberUserId = member.userId;
		if (copiedMemberTimer) clearTimeout(copiedMemberTimer);
		copiedMemberTimer = setTimeout(() => {
			copiedMemberUserId = null;
		}, 2000);
	} catch {}
}

async function copyModSpaceId(id: string) {
	try {
		await copyTextToClipboard(id);
		copiedModSpaceId = id;
		if (copiedModSpaceIdTimer) clearTimeout(copiedModSpaceIdTimer);
		copiedModSpaceIdTimer = setTimeout(() => {
			copiedModSpaceId = null;
		}, 2000);
	} catch {}
}

async function selectMemberRole(
	userId: string,
	currentRole: SpaceRole,
	nextRole: SpaceRole,
) {
	if (currentRole === nextRole) return;
	await updateMemberRole(userId, nextRole);
}

async function updateMemberRole(userId: string, role: SpaceRole) {
	if (!canManageSpaceMembers) return;
	updatingMemberUserId = userId;
	addingMemberError = "";
	try {
		await sdk.space(spaceId).members.update(userId, role);
		invalidateCachedSpaceMembers(spaceId);
		await loadMembers();
	} catch (err) {
		addingMemberError =
			err instanceof Error
				? err.message
				: m.space_failed_member_update({}, { locale });
	} finally {
		updatingMemberUserId = null;
	}
}

async function removeMember(userId: string) {
	if (!canManageSpaceMembers) return;
	if (!window.confirm(m.space_remove_member_confirm({}, { locale }))) return;
	removingMemberUserId = userId;
	addingMemberError = "";
	try {
		await sdk.space(spaceId).members.remove(userId);
		invalidateCachedSpaceMembers(spaceId);
		await loadMembers();
	} catch (err) {
		addingMemberError =
			err instanceof Error
				? err.message
				: m.space_failed_member_remove({}, { locale });
	} finally {
		removingMemberUserId = null;
	}
}

async function saveChannelConfig(
	binding: SpaceChannelBindingRecord,
	config: NonNullable<SpaceChannelBindingRecord["config"]>,
	errorMessage: string,
) {
	if (!canManageSpaceChannels) return;
	channelError = "";
	savingChannelConfigIds = new Set(savingChannelConfigIds).add(binding.id);
	try {
		const updated = await sdk
			.space(spaceId)
			.channels.updateConfig(binding.channelId, config);
		channels = channels.map((item) =>
			item.id === binding.id
				? { ...item, ...updated, channel: item.channel }
				: item,
		);
	} catch (err) {
		channelError = err instanceof Error ? err.message : errorMessage;
	} finally {
		const next = new Set(savingChannelConfigIds);
		next.delete(binding.id);
		savingChannelConfigIds = next;
	}
}

async function saveChannelModel(
	binding: SpaceChannelBindingRecord,
	model: { provider: string; id: string } | null,
) {
	const nextConfig = { ...(binding.config ?? {}), model };
	await saveChannelConfig(
		binding,
		nextConfig,
		m.space_failed_channel_model({}, { locale }),
	);
}

async function saveDiscordRequireMention(
	binding: SpaceChannelBindingRecord,
	requireMentionInGuild: boolean,
) {
	const current = (binding.config ?? {}) as DiscordChannelConfig;
	await saveChannelConfig(
		binding,
		{
			...current,
			inbound: {
				...(current.inbound ?? {}),
				requireMentionInGuild,
			},
		},
		m.space_failed_channel_discord({}, { locale }),
	);
}

async function saveFeishuRequireMention(
	binding: SpaceChannelBindingRecord,
	requireMentionInGroup: boolean,
) {
	const current = (binding.config ?? {}) as FeishuChannelConfig;
	await saveChannelConfig(
		binding,
		{
			...current,
			inbound: {
				...(current.inbound ?? {}),
				requireMentionInGroup,
			},
		},
		m.space_failed_channel_feishu({}, { locale }),
	);
}

async function bindChannel() {
	if (!canManageSpaceChannels || !selectedChannelId) return;
	channelError = "";
	try {
		await sdk.space(spaceId).channels.bind(selectedChannelId);
		channels = await sdk.space(spaceId).channels.list();
		selectedChannelId = "";
	} catch (err) {
		channelError =
			err instanceof Error
				? err.message
				: m.space_failed_channel_bind({}, { locale });
	}
}

async function unbindChannel(channelId: string) {
	if (!canManageSpaceChannels) return;
	channelError = "";
	try {
		await sdk.space(spaceId).channels.unbind(channelId);
		channels = await sdk.space(spaceId).channels.list();
	} catch (err) {
		channelError =
			err instanceof Error
				? err.message
				: m.space_failed_channel_unbind({}, { locale });
	}
}

async function addMod() {
	if (!canManageSpaceMods) return;
	const target = modSpaceId.trim();
	if (!target || modSaving) return;
	if (mods.some((mod) => mod.modSpaceId === target)) {
		modError = m.space_mod_already_mounted({}, { locale });
		return;
	}
	if (!confirmModRestart()) return;
	modSaving = true;
	modError = "";
	try {
		const result = await sdk.space(spaceId).mods.create({
			modSpaceId: target,
			name: modName.trim() || null,
			mountSlug: modMountSlug.trim() || null,
		});
		mods = result.item
			? [...mods, result.item].sort((a, b) => a.sortOrder - b.sortOrder)
			: (await sdk.space(spaceId).mods.list()).items;
		modSpaceId = "";
		modName = "";
		modMountSlug = "";
		noteModRestart();
		await sandboxSettings.load();
	} catch (err) {
		modError =
			err instanceof Error
				? err.message
				: m.space_failed_mod_add({}, { locale });
	} finally {
		modSaving = false;
	}
}

function fillRecommendedMod(mod: DefaultSpaceModDefinition) {
	if (!canManageSpaceMods) return;
	modSpaceId = mod.modSpaceId;
	modName = mod.name ?? "";
	modMountSlug = mod.mountSlug ?? "";
	modError = "";
}

async function toggleMod(mod: SpaceModListItem) {
	if (!canManageSpaceMods) return;
	if (!confirmModRestart()) return;
	modUpdatingId = mod.id;
	modError = "";
	try {
		const result = await sdk
			.space(spaceId)
			.mods.update(mod.id, { enabled: !mod.enabled });
		mods = mods.map((item) => (item.id === mod.id ? result.item : item));
		noteModRestart();
		await sandboxSettings.load();
	} catch (err) {
		modError =
			err instanceof Error
				? err.message
				: m.space_failed_mod_update({}, { locale });
	} finally {
		modUpdatingId = null;
	}
}

async function updateModMountSlug(mod: SpaceModListItem, mountSlug: string) {
	if (!canManageSpaceMods) return;
	if (!confirmModRestart()) return;
	modUpdatingId = mod.id;
	modError = "";
	try {
		const result = await sdk
			.space(spaceId)
			.mods.update(mod.id, { mountSlug: mountSlug || undefined });
		mods = mods.map((item) => (item.id === mod.id ? result.item : item));
		noteModRestart();
		await sandboxSettings.load();
	} catch (err) {
		modError =
			err instanceof Error
				? err.message
				: m.space_failed_mod_update({}, { locale });
	} finally {
		modUpdatingId = null;
	}
}

async function removeMod(mod: SpaceModListItem) {
	if (!canManageSpaceMods) return;
	if (!confirmModRestart()) return;
	modUpdatingId = mod.id;
	modError = "";
	try {
		await sdk.space(spaceId).mods.remove(mod.id);
		mods = mods.filter((item) => item.id !== mod.id);
		noteModRestart();
		await sandboxSettings.load();
	} catch (err) {
		modError =
			err instanceof Error
				? err.message
				: m.space_failed_mod_remove({}, { locale });
	} finally {
		modUpdatingId = null;
	}
}

type SettingsSection =
	| "profile"
	| "access"
	| "environment"
	| "channels"
	| "sandbox";

const settingsSections = $derived([
	{
		id: "profile",
		label: m.space_section_profile({}, { locale }),
		icon: Globe,
	} as const,
	{
		id: "access",
		label: m.space_section_access({}, { locale }),
		icon: Users,
	} as const,
	{
		id: "environment",
		label: m.space_section_env({}, { locale }),
		icon: Terminal,
	} as const,
	{
		id: "channels",
		label: m.space_section_channels({}, { locale }),
		icon: Network,
	} as const,
	{
		id: "sandbox",
		label: m.space_section_sandbox({}, { locale }),
		icon: Settings,
	} as const,
]);

function isSettingsSection(
	value: string | null | undefined,
): value is SettingsSection {
	return settingsSections.some((section) => section.id === value);
}

function sectionElementId(sectionId: SettingsSection) {
	return sectionId;
}

let activeSection = $state<SettingsSection>("profile");
let settingsMainEl = $state<HTMLElement | null>(null);
let scrollSpyObserver: IntersectionObserver | null = null;
let scrollSpyRaf = 0;
let programmaticScroll = false;
let programmaticScrollTimer: ReturnType<typeof setTimeout> | null = null;
let hashRestoredForSpaceId: string | null = null;

function setActiveSection(
	sectionId: SettingsSection,
	{ syncHash = false } = {},
) {
	if (activeSection !== sectionId) activeSection = sectionId;
	if (!syncHash || !browser) return;
	const nextHash = `#${sectionId}`;
	if (window.location.hash === nextHash) return;
	history.replaceState(
		null,
		"",
		`${window.location.pathname}${window.location.search}${nextHash}`,
	);
}

function scrollToSection(sectionId: SettingsSection, { smooth = true } = {}) {
	const el = document.getElementById(sectionElementId(sectionId));
	if (!el) return;
	setActiveSection(sectionId, { syncHash: true });
	programmaticScroll = true;
	if (programmaticScrollTimer) clearTimeout(programmaticScrollTimer);
	el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
	programmaticScrollTimer = setTimeout(
		() => {
			programmaticScroll = false;
		},
		smooth ? 700 : 50,
	);
}

function handleSectionNavClick(event: MouseEvent, sectionId: SettingsSection) {
	event.preventDefault();
	scrollToSection(sectionId);
}

function updateActiveSectionFromScroll() {
	const main = settingsMainEl;
	if (!main || programmaticScroll) return;
	const marker = main.getBoundingClientRect().top + 48;
	const top = (id: SettingsSection) =>
		document.getElementById(sectionElementId(id))?.getBoundingClientRect().top;
	let next: SettingsSection = settingsSections[0].id;
	for (const section of settingsSections) {
		const y = top(section.id);
		if (y !== undefined && y <= marker) next = section.id;
	}
	// Keep short trailing sections selectable even when they cannot reach the marker.
	const atBottom =
		main.scrollTop > 0 &&
		main.scrollTop + main.clientHeight >= main.scrollHeight - 2;
	if (atBottom) {
		const current = top(activeSection);
		next =
			current !== undefined && current > marker
				? activeSection
				: settingsSections[settingsSections.length - 1].id;
	}
	setActiveSection(next, { syncHash: true });
}

function scheduleActiveSectionFromScroll() {
	if (scrollSpyRaf) cancelAnimationFrame(scrollSpyRaf);
	scrollSpyRaf = requestAnimationFrame(() => {
		scrollSpyRaf = 0;
		updateActiveSectionFromScroll();
	});
}

function bindScrollSpy(main: HTMLElement | null) {
	scrollSpyObserver?.disconnect();
	scrollSpyObserver = null;
	if (!main || typeof IntersectionObserver === "undefined") return;
	scrollSpyObserver = new IntersectionObserver(
		() => scheduleActiveSectionFromScroll(),
		{
			root: main,
			rootMargin: "-12% 0px -72% 0px",
			threshold: [0, 0.1, 0.25, 0.5, 1],
		},
	);
	for (const section of settingsSections) {
		const el = document.getElementById(sectionElementId(section.id));
		if (el) scrollSpyObserver.observe(el);
	}
	updateActiveSectionFromScroll();
}

$effect(() => {
	if (!browser || !spaceId) return;
	const id = spaceId;
	return subscribeSpaceChannel(id, (event) => {
		if (event.type !== WORKSPACE_USAGE_UPDATED_EVENT) return;
		const usage = (event.payload as { workspaceUsage?: unknown })
			.workspaceUsage;
		const current = space;
		if (!isWorkspaceUsage(usage) || !current || current.id !== id) return;
		space = { ...current, workspaceUsage: usage };
		cacheSpaceRecordSoon(space);
	});
});

$effect(() => {
	void loadPage();
});

$effect(() => {
	if (!browser || loading || error || !settingsMainEl) return;
	const main = settingsMainEl;
	const currentSpaceId = spaceId;
	untrack(() => {
		const hash = window.location.hash.replace(/^#/, "");
		const restoreHash =
			hashRestoredForSpaceId !== currentSpaceId && isSettingsSection(hash);
		hashRestoredForSpaceId = currentSpaceId;
		bindScrollSpy(main);
		if (restoreHash) {
			requestAnimationFrame(() => scrollToSection(hash, { smooth: false }));
		}
	});
	return () => {
		scrollSpyObserver?.disconnect();
		scrollSpyObserver = null;
		if (scrollSpyRaf) cancelAnimationFrame(scrollSpyRaf);
		scrollSpyRaf = 0;
	};
});
</script>

<svelte:head><title>{m.space_title({}, { locale })} — Cohub</title></svelte:head>

<div class="flex min-h-0 flex-1 flex-col overflow-hidden bg-bg-primary">
	<div class="shrink-0 border-b border-border-subtle">
		<ListHeader title={m.space_title({}, { locale })} brand={false}>
			<HeaderAction label={m.space_back({}, { locale })} icon={ArrowLeft} onclick={goBack} />
			<h1 class="min-w-0 truncate text-[15px] font-semibold tracking-tight text-text-primary lg:text-[13px]">{m.space_title({}, { locale })}</h1>
			{#snippet actions()}
				<HeaderAction label={m.wallet_title({}, { locale })} icon={Wallet} href={`/spaces/${spaceId}/wallet`} showLabel />
				<HeaderAction label={m.space_section_commerce({}, { locale })} icon={PackagePlus} href={`/spaces/${spaceId}/settings/commerce`} showLabel />
			{/snippet}
		</ListHeader>
		<div class="lg:hidden">
			<FilterBar label={m.space_sections({}, { locale })} role="navigation" activeKey={activeSection}>
				{#each settingsSections as section (section.id)}
					<FilterChip label={section.label} href={`#${section.id}`} active={activeSection === section.id} onclick={(event) => handleSectionNavClick(event, section.id)} />
				{/each}
			</FilterBar>
		</div>
	</div>

	<div class="flex min-h-0 flex-1">
		<nav class="hidden w-44 shrink-0 flex-col gap-[2px] border-r border-border-subtle px-2 py-3 lg:flex" aria-label={m.space_sections({}, { locale })}>
			{#each settingsSections as section (section.id)}
				<a
					href={`#${section.id}`}
					aria-current={activeSection === section.id ? "location" : undefined}
					class="flex items-center gap-2.5 rounded-[5px] px-2 py-2 text-left text-[13px] transition-colors duration-100 {activeSection === section.id ? 'bg-bg-active font-medium text-text-primary' : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'}"
					onclick={(event) => handleSectionNavClick(event, section.id)}
				>
					<section.icon class="h-[15px] w-[15px] shrink-0" />
					<span class="truncate">{section.label}</span>
				</a>
			{/each}
		</nav>

		<main bind:this={settingsMainEl} class="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 sm:py-7">
			<div class="mx-auto w-full max-w-2xl">
				{#if loading}
					<div aria-hidden="true">
						<div class="h-5 w-24 rounded bg-bg-hover-strong"></div>
						<div class="mt-2 h-3.5 w-52 rounded bg-bg-hover-strong"></div>
						<div class="space-y-3 py-6">
							<div class="h-9 w-full rounded-[5px] bg-bg-hover-strong"></div>
							<div class="h-9 w-full rounded-[5px] bg-bg-hover-strong"></div>
							<div class="h-20 w-full rounded-[5px] bg-bg-hover-strong"></div>
						</div>
					</div>
				{:else if error}
					<div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] text-error-soft">{error}</div>
				{:else}
					<div class="pb-10">
						<section id={sectionElementId("profile")} class="scroll-mt-6">
						<SettingsHeading title={m.space_section_profile({}, { locale })} description={m.space_profile_desc({}, { locale })} />

						<div class="flex items-start gap-4 py-6">
							<div class="flex w-16 shrink-0 flex-col items-center gap-1.5">
								{#if canEditSpaceProfile}
									<label class="group relative h-14 w-14 cursor-pointer overflow-hidden rounded-full border border-border-subtle bg-bg-hover-strong transition-colors hover:border-brand/50 focus-within:border-brand/50" title={m.space_change_avatar({}, { locale })} aria-label={m.space_change_avatar({}, { locale })}>
										<SpaceAvatar name={space?.name || space?.title || spaceId} profile={space?.publicProfile} seed={spaceId} size="lg" class="h-full w-full rounded-full border-0" />
										<span class="absolute inset-0 flex items-center justify-center bg-overlay-scrim-strong opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
											{#if spaceAvatarUploading}<Loader2 class="h-4 w-4 animate-spin text-overlay-control-text" />{:else}<Upload class="h-4 w-4 text-overlay-control-text" />{/if}
										</span>
										<input type="file" accept="image/jpeg,image/png,image/gif,image/webp" class="sr-only" disabled={spaceAvatarUploading} onchange={handleSpaceAvatarFileChange} />
									</label>
									<label class="inline-flex cursor-pointer items-center gap-1 rounded-[4px] px-1 py-0.5 text-[11px] leading-none text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary {spaceAvatarUploading ? 'pointer-events-none opacity-70' : ''}">
										{#if spaceAvatarUploading}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Upload class="h-3 w-3" />{/if}
										<span aria-live="polite">{spaceAvatarUploadStage === "preparing" ? m.space_preparing({}, { locale }) : spaceAvatarUploadStage === "uploading" ? `${spaceAvatarUploadProgress}%` : spaceAvatarUploadStage === "saving" ? m.space_saving({}, { locale }) : space?.publicProfile?.avatarUrl ? m.space_change({}, { locale }) : m.space_upload({}, { locale })}</span>
										<input type="file" accept="image/jpeg,image/png,image/gif,image/webp" class="sr-only" disabled={spaceAvatarUploading} onchange={handleSpaceAvatarFileChange} />
									</label>
									{#if spaceAvatarUploading}
										<UploadProgress class="w-12 rounded-full" value={spaceAvatarUploadStage === "uploading" ? spaceAvatarUploadProgress : null} label={m.space_avatar_progress({}, { locale })} />
									{/if}
								{:else}
									<SpaceAvatar name={space?.name || space?.title || spaceId} profile={space?.publicProfile} seed={spaceId} size="lg" class="h-14 w-14 rounded-full" />
								{/if}
							</div>

							<div class="min-w-0 flex-1 pt-0.5">
								{#if renamingSpace && canEditSpaceProfile}
									<div class="flex min-w-0 items-center gap-2">
										<input type="text" bind:value={renameInput} disabled={renameSaving} aria-label={m.space_name({}, { locale })} class="min-w-0 flex-1 rounded-[5px] border border-brand/40 bg-bg-input px-2.5 py-1.5 text-[15px] font-medium text-text-primary transition-colors focus:outline-none disabled:opacity-60" onkeydown={(event) => { if (event.key === 'Enter' && !renameSaving && !isComposingKeyboardEvent(event)) { event.preventDefault(); const trimmed = renameInput.trim(); if (trimmed && trimmed !== space?.name) void handleRenameSpace(trimmed); else { renamingSpace = false; renameError = ''; } } if (event.key === 'Escape' && !renameSaving) { renamingSpace = false; renameError = ''; } }} />
										<button type="button" class="shrink-0 rounded-[5px] p-1.5 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50" title={m.space_save_name({}, { locale })} disabled={renameSaving} onclick={() => { const trimmed = renameInput.trim(); if (trimmed && trimmed !== space?.name) void handleRenameSpace(trimmed); else { renamingSpace = false; renameError = ''; } }}>{#if renameSaving}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Check class="h-3.5 w-3.5" />{/if}</button>
										<button type="button" class="shrink-0 rounded-[5px] p-1.5 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50" title={m.space_cancel({}, { locale })} disabled={renameSaving} onclick={() => { renamingSpace = false; renameError = ''; }}><X class="h-3.5 w-3.5" /></button>
									</div>
								{:else if canEditSpaceProfile}
									<button type="button" onclick={() => { renameInput = space?.name ?? ''; renamingSpace = true; renameError = ''; }} class="group/edit -ml-1 flex max-w-full items-center gap-1.5 rounded-[5px] px-1 py-0.5 text-left transition-colors hover:bg-bg-hover" title={m.space_rename_space({}, { locale })}><span class="min-w-0 truncate text-[15px] font-medium text-text-primary group-hover/edit:text-brand">{space?.name || space?.title || spaceId}</span><Pencil class="h-3 w-3 shrink-0 text-text-placeholder opacity-0 transition-opacity group-hover/edit:opacity-100" /></button>
								{:else}
									<h2 class="min-w-0 truncate text-[15px] font-medium text-text-primary">{space?.name || space?.title || spaceId}</h2>
								{/if}
								{#if renameError}<p class="mt-1 text-[11px] text-error-soft">{renameError}</p>{/if}

								<div class="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-text-tertiary">
									<span class="shrink-0 uppercase tracking-wider">{m.space_id({}, { locale })}</span>
									<code class="min-w-0 truncate font-mono" title={spaceId}>{formatCompactId(spaceId)}</code>
									<button type="button" onclick={() => void copySpaceId()} class="shrink-0 rounded-[4px] p-1 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary" title={m.space_copy_space_id({}, { locale })}>
										{#if copiedSpaceId}<Check class="h-3 w-3 text-status-running" />{:else}<Copy class="h-3 w-3" />{/if}
									</button>
								</div>

								<div class="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-text-tertiary">
									<span class="shrink-0 uppercase tracking-wider">{m.space_url({}, { locale })}</span>
									{#if editingSpaceSlug && canEditSpaceProfile}
										<div class="flex min-w-0 flex-1 items-center gap-1.5">
											<div class="flex min-w-0 flex-1 items-center rounded-[5px] border border-brand/40 bg-bg-input px-2 py-1"><span class="shrink-0 font-mono {getSpaceOwnerUsername(space) ? 'text-text-tertiary' : 'text-text-placeholder'}">/{getSpaceOwnerUsername(space) || 'username'}/</span><input aria-label={m.space_slug({}, { locale })} bind:value={spaceSlugDraft} placeholder="my-space" maxlength="80" onkeydown={handleSpaceSlugKeydown} disabled={spaceSlugSaving} class="min-w-0 flex-1 bg-transparent font-mono text-text-primary placeholder:text-text-placeholder focus:outline-none" /></div>
											<button type="button" onclick={() => void saveSpaceSlug()} disabled={spaceSlugSaving} class="shrink-0 rounded-[4px] p-1 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50" title={m.space_save_slug({}, { locale })}>{#if spaceSlugSaving}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Check class="h-3 w-3" />{/if}</button>
											<button type="button" onclick={cancelSpaceSlugEdit} disabled={spaceSlugSaving} class="shrink-0 rounded-[4px] p-1 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50" title={m.space_cancel({}, { locale })}><X class="h-3 w-3" /></button>
										</div>
									{:else}
										{#if getSpacePublicPath(space)}
											<button type="button" onclick={() => void copySpacePublicLink()} class="inline-flex min-w-0 items-center gap-1 truncate font-mono transition-colors hover:text-text-secondary" title={m.space_copy_public_url({}, { locale })}><span class="min-w-0 truncate">{getSpacePublicPath(space)}</span>{#if copiedSpaceSlugLink}<Check class="h-3 w-3 shrink-0 text-status-running" />{:else}<Copy class="h-3 w-3 shrink-0" />{/if}</button>
										{:else if getSpaceSlug(space)}
											<code class="min-w-0 truncate font-mono"><span class="text-text-placeholder">/username/</span>{getSpaceSlug(space)}</code>
										{:else}
											<span class="text-text-placeholder">{m.space_not_set({}, { locale })}</span>
										{/if}
										{#if canEditSpaceProfile}
											<button type="button" onclick={beginSpaceSlugEdit} class="shrink-0 rounded-[4px] p-1 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary" title={m.space_edit_slug({}, { locale })}><Pencil class="h-3 w-3" /></button>
										{/if}
									{/if}
								</div>
								{#if spaceSlugError}<p class="mt-1 text-[11px] text-error-soft break-words">{spaceSlugError}</p>{/if}
								{#if getSpacePrettyUrlHint(space) && !editingSpaceSlug}<p class="mt-1 text-[11px] leading-4 text-text-placeholder">{getSpacePrettyUrlHint(space)}</p>{/if}
							</div>
						</div>

						<div class="border-t border-border-subtle py-6">
							<label class="block text-[13px] font-medium text-text-primary" for="space-description">{m.space_description({}, { locale })}</label>
							<textarea id="space-description" bind:value={spaceDescriptionDraft} rows="3" maxlength="2000" disabled={!canEditSpaceProfile || spaceDescriptionSaving} onkeydown={handleDescriptionKeydown} class="mt-2 w-full resize-y rounded-[5px] border border-border-subtle bg-bg-input px-2.5 py-2 text-[13px] leading-5 text-text-primary placeholder:text-text-placeholder transition-colors focus:border-brand/40 focus:outline-none disabled:opacity-60" placeholder={m.space_what_for({}, { locale })}></textarea>
							{#if canEditSpaceProfile}
								<div class="mt-3">
									<button type="button" onclick={() => void saveSpaceDescription()} disabled={spaceDescriptionSaving || spaceDescriptionDraft.trim() === (space?.description ?? '').trim()} class="inline-flex h-8 items-center justify-center gap-1.5 rounded-[5px] bg-brand px-3 text-[12px] font-medium text-brand-contrast-fg transition-colors hover:bg-brand-hover disabled:opacity-50">{#if spaceDescriptionSaving}<Loader2 class="h-3.5 w-3.5 animate-spin" /> {m.space_saving({}, { locale })}{:else}{m.space_save({}, { locale })}{/if}</button>
								</div>
							{/if}
							{#if spaceProfileError}<p class="mt-2 text-[12px] text-error-soft break-words">{spaceProfileError}</p>{/if}
						</div>
						</section>

						<section id={sectionElementId("access")} class="-scroll-mt-4 border-t border-border-subtle pt-10">
						<SettingsHeading title={m.space_section_access({}, { locale })} description={m.space_access_desc({}, { locale })}>
							{#snippet action()}
								{#if canManageSpaceMembers}
									<button type="button" onclick={() => { showInvitePanel = true; }} class="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[5px] border border-brand-border bg-brand-muted px-2.5 text-[12px] font-medium text-brand transition-colors hover:bg-brand-muted-hover"><Link class="h-3.5 w-3.5" /> {m.space_invite({}, { locale })}</button>
								{/if}
							{/snippet}
						</SettingsHeading>

						<div class="mt-2 divide-y divide-border-subtle border-b border-border-subtle">
							<SettingsRow label={m.space_signed_in_users({}, { locale })} hint={m.space_access_any_signed_in({}, { locale })} for="access-signed-in">
								{#snippet control()}
									<select id="access-signed-in" value={access?.signed_in_user ?? ""} disabled={!canManageSpaceMembers} onchange={(e) => { const value = e.currentTarget.value as SpaceRole | ""; void setAccess({ signed_in_user: value || null }); }} class="{SETTINGS_SELECT} w-28"><option value="">{m.space_role_no_access({}, { locale })}</option><option value="guest">{m.space_role_guest({}, { locale })}</option><option value="builder">{m.space_role_builder({}, { locale })}</option></select>
								{/snippet}
							</SettingsRow>
							<SettingsRow label={m.space_access_anon({}, { locale })} hint={m.space_access_no_account({}, { locale })} for="access-anonymous">
								{#snippet control()}
									<select id="access-anonymous" value={access?.anonymous_user ?? ""} disabled={!canManageSpaceMembers} onchange={(e) => { const value = e.currentTarget.value as SpaceRole | ""; void setAccess({ anonymous_user: value || null }); }} class="{SETTINGS_SELECT} w-28"><option value="">{m.space_role_no_access({}, { locale })}</option><option value="guest">{m.space_role_guest({}, { locale })}</option></select>
								{/snippet}
							</SettingsRow>
							<SettingsRow label={m.space_guest_page({}, { locale })} hint={m.space_guest_page_hint({}, { locale })} for="access-guest-page">
								{#snippet control()}
									{@const guestAppId = space?.meta?.config?.guest?.appId ?? ""}
									<select id="access-guest-page" value={guestAppId} disabled={!canEditSpaceProfile} onchange={(e) => { void setGuestApp(e.currentTarget.value); }} class="{SETTINGS_SELECT} w-40">
										<option value="">{m.space_guest_page_default({}, { locale })}</option>
										{#each guestApps as app (app.id)}<option value={app.id}>{appDisplayTitle(app.meta, app.slug)}</option>{/each}
										{#if guestAppId && !guestApps.some((app) => app.id === guestAppId)}<option value={guestAppId} disabled>{m.space_guest_page_unavailable({}, { locale })}</option>{/if}
									</select>
								{/snippet}
							</SettingsRow>
						</div>
						{#if accessError}<p class="mt-3 text-[12px] text-error-soft break-words">{accessError}</p>{/if}

						<div class="py-6">
							<h2 class="text-[13px] font-medium text-text-primary">{m.space_members_caption({}, { locale })} <span class="font-normal text-text-tertiary">· {members.length}</span></h2>
							<div class="mt-3 overflow-hidden rounded-md border border-border-subtle">
								<div class="divide-y divide-border-subtle">
									{#each members as member (member.userId)}
										{@const name = getMemberDisplayName(member)}
										<div data-density="compact" class="flex h-[var(--list-row-height)] items-center gap-[var(--list-row-gap)] px-3">
											<UserAvatar {name} avatarUrl={member.profile?.avatarUrl} seed={member.userId} size={LIST_ROW_AVATAR.compact} />
											<ListRowText title={name} tooltip={name}>
												{#snippet badge()}
													{#if getMemberRoleIcon(member.role)}<span class="shrink-0 text-[11px]" title={m.space_role_host({}, { locale })}>{getMemberRoleIcon(member.role)}</span>{/if}
												{/snippet}
												{#snippet subtitle()}
													<button type="button" onclick={() => { void copyMemberUuid(member); }} title={m.space_copy_user_uuid({}, { locale })} class="inline-flex max-w-full items-center gap-1 align-top font-mono text-[11px] text-text-placeholder transition-colors hover:text-text-secondary"><span class="min-w-0 truncate">{getMemberUuid(member)}</span>{#if copiedMemberUserId === member.userId}<Check class="h-3 w-3 shrink-0 text-status-running" />{/if}</button>
												{/snippet}
											</ListRowText>
											<select value={member.role} disabled={!canManageSpaceMembers || updatingMemberUserId === member.userId || removingMemberUserId === member.userId} onchange={(e) => { const role = (e.currentTarget as HTMLSelectElement).value as SpaceRole; void selectMemberRole(member.userId, member.role, role); }} class="h-8 w-24 shrink-0 rounded-[5px] border border-border-subtle bg-bg-input px-2 text-[12px] text-text-primary focus:border-brand/40 focus:outline-none disabled:opacity-50" aria-label={`${name} role`}>
												{#each memberRoleOptions as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
											</select>
											<button type="button" onclick={() => { void removeMember(member.userId); }} disabled={!canManageSpaceMembers || removingMemberUserId === member.userId} title={m.space_remove_member({}, { locale })} class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-error-bg hover:text-error-soft disabled:opacity-40">{#if removingMemberUserId === member.userId}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Trash2 class="h-3.5 w-3.5" />{/if}</button>
										</div>
									{:else}
										<div class="px-3 py-4 text-center text-[12px] text-text-tertiary">{m.space_no_members({}, { locale })}</div>
									{/each}
								</div>
								{#if canManageSpaceMembers}
									<div class="flex flex-col gap-2 border-t border-border-subtle bg-bg-header-alt px-3 py-2.5 sm:flex-row sm:items-center">
										<input type="text" bind:value={addingMemberUuid} placeholder={m.space_user_uuid({}, { locale })} onkeydown={(event) => { if (event.key === 'Enter' && !isComposingKeyboardEvent(event)) { event.preventDefault(); void addMember(); } }} class="h-8 min-w-0 flex-1 rounded-[5px] border border-border-subtle bg-bg-input px-2.5 font-mono text-[12px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none" />
										<div class="flex items-center gap-2">
											<select bind:value={addingMemberRole} class="h-8 w-24 rounded-[5px] border border-border-subtle bg-bg-input px-2 text-[12px] text-text-primary focus:border-brand/40 focus:outline-none" aria-label={m.space_new_member_role({}, { locale })}>
												{#each memberRoleOptions as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
											</select>
											<button type="button" onclick={() => { void addMember(); }} disabled={savingMember || !addingMemberUuid.trim()} class="inline-flex h-8 items-center justify-center gap-1.5 rounded-[5px] border border-border-subtle bg-bg-input px-3 text-[12px] font-medium text-text-primary transition-colors hover:bg-bg-hover disabled:opacity-50">{#if savingMember}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Plus class="h-3.5 w-3.5" />{/if} Add</button>
										</div>
									</div>
								{/if}
							</div>
							{#if addingMemberError}<p class="mt-2 text-[12px] text-error-soft break-words">{addingMemberError}</p>{/if}
						</div>

						{#if canManageSpaceMembers}
							<SpaceInvitations {spaceId} ownerUsername={getSpaceOwnerUsername(space) || null} spaceSlug={getSpaceSlug(space) || null} bind:createOpen={showInvitePanel} />
						{/if}
						</section>

						<section id={sectionElementId("environment")} class="-scroll-mt-4 border-t border-border-subtle pt-10">
						<SettingsHeading title={m.space_section_env({}, { locale })} description={m.space_env_desc({}, { locale })} />

						<div class="py-6">
							<h2 class="text-[13px] font-medium text-text-primary">{m.space_variables({}, { locale })}<span class="font-normal text-text-tertiary">· {env.length}</span></h2>
							<p class="mt-0.5 text-[12px] leading-5 text-text-tertiary">{m.space_available_to_process({}, { locale })}</p>
							<div class="mt-3 overflow-hidden rounded-md border border-border-subtle">
								<div class="divide-y divide-border-subtle">
									{#each env as item (item.name)}
										<div class="flex items-center gap-3 px-3 py-2">
											<code class="w-32 shrink-0 truncate font-mono text-[11px] text-text-primary sm:w-40" title={item.name}>{item.name}</code>
											<code class="min-w-0 flex-1 truncate font-mono text-[11px] text-text-tertiary">{revealedEnvNames.has(item.name) ? item.value : '••••••••'}</code>
											<button type="button" onclick={() => toggleEnvReveal(item.name)} class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary" title={revealedEnvNames.has(item.name) ? m.space_hide({}, { locale }) : m.space_reveal({}, { locale })}>{#if revealedEnvNames.has(item.name)}<EyeOff class="h-3.5 w-3.5" />{:else}<Eye class="h-3.5 w-3.5" />{/if}</button>
											{#if canEditSpaceProfile}
												<button type="button" onclick={() => removeEnv(item.name)} class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-error-bg hover:text-error-soft" title={m.space_remove_variable({}, { locale })}><Trash2 class="h-3.5 w-3.5" /></button>
											{/if}
										</div>
									{:else}
										<div class="px-3 py-4 text-center text-[12px] text-text-tertiary">{m.space_no_vars({}, { locale })}</div>
									{/each}
								</div>
								{#if canEditSpaceProfile}
									<div class="flex flex-col gap-2 border-t border-border-subtle bg-bg-header-alt px-3 py-2.5 sm:flex-row sm:items-center">
										<input bind:value={envName} placeholder={m.space_name_label({}, { locale })} onkeydown={(event) => { if (event.key === 'Enter' && !isComposingKeyboardEvent(event)) { event.preventDefault(); addEnv(); } }} class="h-8 w-full min-w-0 rounded-[5px] border border-border-subtle bg-bg-input px-2.5 font-mono text-[12px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none sm:w-40" />
										<input bind:value={envValue} placeholder="value" onkeydown={(event) => { if (event.key === 'Enter' && !isComposingKeyboardEvent(event)) { event.preventDefault(); addEnv(); } }} class="h-8 min-w-0 flex-1 rounded-[5px] border border-border-subtle bg-bg-input px-2.5 font-mono text-[12px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none" />
										<button type="button" onclick={addEnv} disabled={!envName.trim()} class="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[5px] border border-border-subtle bg-bg-input px-3 text-[12px] font-medium text-text-primary transition-colors hover:bg-bg-hover disabled:opacity-50"><Plus class="h-3.5 w-3.5" /> {m.space_add({}, { locale })}</button>
									</div>
								{/if}
							</div>
							{#if envError}<p class="mt-2 text-[12px] text-error-soft break-words">{envError}</p>{/if}
						</div>

						<div class="border-t border-border-subtle py-6">
							<h2 class="text-[13px] font-medium text-text-primary">{m.space_mounted_spaces({}, { locale })}<span class="font-normal text-text-tertiary">· {mods.length}</span></h2>
							<p class="mt-0.5 max-w-xl text-[12px] leading-5 text-text-tertiary">{m.space_mounted_readonly({}, { locale })} <code class="font-mono text-text-secondary">/mods/&lt;slug&gt;</code>. {m.space_mount_changes_restart({}, { locale })}</p>
							{#if shouldShowBaseModRecommendation && recommendedBaseMod && canManageSpaceMods}
								<div class="mt-3 flex flex-col gap-2 rounded-md border border-brand-border bg-brand-muted px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
									<div class="min-w-0">
										<div class="text-[12px] font-medium text-text-primary">{recommendedBaseMod.name} <span class="font-normal text-text-tertiary">— {m.space_recommended({}, { locale })}</span></div>
										<div class="mt-0.5 break-all font-mono text-[10px] text-text-tertiary">/mods/{recommendedBaseMod.mountSlug}</div>
										<button type="button" onclick={() => { void copyModSpaceId(recommendedBaseMod.modSpaceId); }} title={m.space_copy_mod_space_id({}, { locale })} class="mt-0.5 inline-flex max-w-full items-center gap-1 font-mono text-[10px] text-text-placeholder transition-colors hover:text-text-secondary"><span class="min-w-0 truncate">{recommendedBaseMod.modSpaceId}</span>{#if copiedModSpaceId === recommendedBaseMod.modSpaceId}<Check class="h-3 w-3 shrink-0 text-status-running" />{/if}</button>
									</div>
									<button type="button" onclick={() => fillRecommendedMod(recommendedBaseMod)} class="inline-flex h-7 shrink-0 items-center justify-center rounded-[5px] border border-brand-border px-2.5 text-[11px] font-medium text-brand transition-colors hover:bg-brand-muted-hover">{m.space_use({}, { locale })}</button>
								</div>
							{/if}
							<div class="mt-3 overflow-hidden rounded-md border border-border-subtle">
								<div class="divide-y divide-border-subtle">
									{#each mods as mod (mod.id)}
										<div class="flex items-start gap-3 px-3 py-2.5">
											<div class="min-w-0 flex-1">
												<div class="flex flex-wrap items-center gap-2">
													<span class="truncate text-[13px] font-medium text-text-primary">{mod.name ?? mod.modSpaceName ?? mod.modSpaceId}</span>
													<span class="tag uppercase tracking-wider {mod.enabled ? '' : 'text-text-placeholder'}" data-tone={mod.enabled ? 'success' : undefined}>{mod.enabled ? m.space_on({}, { locale }) : m.space_off({}, { locale })}</span>
												</div>
												<div class="mt-0.5 break-all font-mono text-[10px] text-text-placeholder">{mod.mountPath}</div>
												<button type="button" onclick={() => { void copyModSpaceId(mod.modSpaceId); }} title={m.space_copy_mod_space_id({}, { locale })} class="mt-0.5 inline-flex max-w-full items-center gap-1 font-mono text-[10px] text-text-placeholder transition-colors hover:text-text-secondary"><span class="min-w-0 truncate">{mod.modSpaceId}</span>{#if copiedModSpaceId === mod.modSpaceId}<Check class="h-3 w-3 shrink-0 text-status-running" />{/if}</button>
												{#if canManageSpaceMods}
													<input value={mod.mountSlug} onblur={(event) => { const slug = (event.currentTarget as HTMLInputElement).value.trim(); if (slug !== mod.mountSlug) { void updateModMountSlug(mod, slug); } }} onkeydown={(event) => { if (event.key === 'Enter' && !isComposingKeyboardEvent(event)) { event.preventDefault(); const slug = (event.currentTarget as HTMLInputElement).value.trim(); if (slug !== mod.mountSlug) { void updateModMountSlug(mod, slug); } } }} placeholder="mount slug" aria-label={m.space_mount_slug({}, { locale })} class="mt-1.5 w-full max-w-[200px] rounded-[4px] border border-border-subtle bg-bg-input px-2 py-1 font-mono text-[11px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none" />
												{/if}
											</div>
											{#if canManageSpaceMods}
												<div class="flex shrink-0 items-center gap-0.5">
													<button type="button" onclick={() => toggleMod(mod)} disabled={modUpdatingId === mod.id} class="inline-flex h-7 items-center rounded-[5px] px-2 text-[11px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50">{mod.enabled ? m.space_disable({}, { locale }) : m.space_enable({}, { locale })}</button>
													<button type="button" onclick={() => removeMod(mod)} disabled={modUpdatingId === mod.id} title={m.space_remove_mod({}, { locale })} class="inline-flex h-7 w-7 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-error-bg hover:text-error-soft disabled:opacity-50"><Trash2 class="h-3.5 w-3.5" /></button>
												</div>
											{/if}
										</div>
									{:else}
										<div class="px-3 py-4 text-center text-[12px] text-text-tertiary">{m.space_no_mounted({}, { locale })}</div>
									{/each}
								</div>
								{#if canManageSpaceMods}
									<div class="flex flex-col gap-2 border-t border-border-subtle bg-bg-header-alt px-3 py-2.5">
										<div class="flex flex-col gap-2 sm:flex-row sm:items-center">
											<input bind:value={modSpaceId} placeholder={m.space_mod_space_id({}, { locale })} class="h-8 min-w-0 flex-1 rounded-[5px] border border-border-subtle bg-bg-input px-2.5 font-mono text-[12px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none" />
											<div class="flex items-center gap-2">
												<input bind:value={modName} placeholder={m.space_name_optional({}, { locale })} class="h-8 w-full min-w-0 rounded-[5px] border border-border-subtle bg-bg-input px-2.5 text-[12px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none sm:w-32" />
												<input bind:value={modMountSlug} placeholder={m.space_slug_optional({}, { locale })} class="h-8 w-full min-w-0 rounded-[5px] border border-border-subtle bg-bg-input px-2.5 font-mono text-[12px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none sm:w-32" />
												<button type="button" onclick={addMod} disabled={modSaving || !modSpaceId.trim()} class="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[5px] border border-border-subtle bg-bg-input px-3 text-[12px] font-medium text-text-primary transition-colors hover:bg-bg-hover disabled:opacity-50">{#if modSaving}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Plus class="h-3.5 w-3.5" />{/if} Add</button>
											</div>
										</div>
									</div>
								{/if}
							</div>
							{#if modError}<p class="mt-2 text-[12px] text-error-soft break-words">{modError}</p>{/if}
							{#if modRestartMessage}<div class="mt-3 rounded-md border border-success-soft/30 bg-success-bg px-3 py-2 text-[12px] text-success-soft">{modRestartMessage}</div>{/if}
						</div>
						</section>

						<section id={sectionElementId("channels")} class="-scroll-mt-4 border-t border-border-subtle pt-10">
						<SettingsHeading title={m.space_section_channels({}, { locale })} description={m.space_channels_desc({}, { locale })} />

						<div class="py-6">
							<div class="overflow-hidden rounded-md border border-border-subtle">
								<div class="divide-y divide-border-subtle">
									{#each channels as binding (binding.id)}
										<div class="px-3 py-2.5">
											<div class="flex items-start justify-between gap-3">
												<div class="min-w-0 flex-1">
													<div class="flex min-w-0 flex-wrap items-center gap-2">
														<span class="min-w-0 truncate text-[13px] font-medium text-text-primary">{binding.channel?.provider ?? 'channel'} · {binding.channel?.name ?? binding.channelId}</span>
														<span class={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ${channelHealthClass(binding.health?.state ?? "connecting")}`}>
															{channelHealthLabel(binding.health, { bound: true })}
														</span>
													</div>
													{#if channelHealthMessage(binding.health)}
														<p class="mt-1 text-[12px] leading-4 text-error-soft break-words" title={channelHealthDetail(binding.health) ?? undefined}>
															{channelHealthMessage(binding.health)}
															{#if channelHealthDetail(binding.health)}
																<span class="text-text-tertiary"> · {channelHealthDetail(binding.health)}</span>
															{/if}
														</p>
													{/if}
												</div>
												{#if canManageSpaceChannels}
													<button type="button" onclick={() => unbindChannel(binding.channelId)} class="inline-flex h-7 shrink-0 items-center rounded-[5px] px-2 text-[11px] text-text-tertiary transition-colors hover:bg-error-bg hover:text-error-soft">{m.space_unbind({}, { locale })}</button>
												{/if}
											</div>
											<div class="mt-2"><ChannelModelPicker model={binding.config?.model ?? null} disabled={!canManageSpaceChannels} saving={savingChannelConfigIds.has(binding.id)} onSelect={(model) => saveChannelModel(binding, model)} /></div>
											{#if binding.channel?.provider === "discord"}
												{@const discordConfig = (binding.config ?? {}) as DiscordChannelConfig}
												<label class="mt-2 flex items-center gap-2 rounded-[5px] border border-border-subtle bg-bg-code px-2.5 py-2 text-[12px] text-text-secondary">
													<input
														type="checkbox"
														checked={discordConfig.inbound?.requireMentionInGuild ?? true}
														disabled={!canManageSpaceChannels || savingChannelConfigIds.has(binding.id)}
														onchange={(event) => saveDiscordRequireMention(binding, event.currentTarget.checked)}
														class="disabled:opacity-50"
													/>
													<span class="min-w-0">{m.space_require_discord_mention({}, { locale })}</span>
												</label>
											{:else if binding.channel?.provider === "feishu"}
												{@const feishuConfig = (binding.config ?? {}) as FeishuChannelConfig}
												<label class="mt-2 flex items-center gap-2 rounded-[5px] border border-border-subtle bg-bg-code px-2.5 py-2 text-[12px] text-text-secondary">
													<input
														type="checkbox"
														checked={feishuConfig.inbound?.requireMentionInGroup ?? true}
														disabled={!canManageSpaceChannels || savingChannelConfigIds.has(binding.id)}
														onchange={(event) => saveFeishuRequireMention(binding, event.currentTarget.checked)}
														class="disabled:opacity-50"
													/>
													<span class="min-w-0">{m.space_require_feishu_mention({}, { locale })}</span>
												</label>
											{/if}
										</div>
									{:else}
										<div class="px-3 py-4 text-center text-[12px] text-text-tertiary">{m.space_no_channels({}, { locale })}<a href="/settings/channels" class="text-text-secondary underline underline-offset-2 hover:text-text-primary">{m.space_manage_channels({}, { locale })}</a></div>
									{/each}
								</div>
								{#if canManageSpaceChannels && allChannels.filter((ch) => !channels.some((binding) => binding.channelId === ch.id)).length > 0}
									<div class="flex flex-col gap-2 border-t border-border-subtle bg-bg-header-alt px-3 py-2.5 sm:flex-row sm:items-center">
										<select bind:value={selectedChannelId} class="h-8 min-w-0 flex-1 rounded-[5px] border border-border-subtle bg-bg-input px-2.5 text-[12px] text-text-primary focus:border-brand/40 focus:outline-none" aria-label={m.space_channel_to_bind({}, { locale })}>
											<option value="">{m.space_select_channel({}, { locale })}</option>
											{#each allChannels.filter((ch) => !channels.some((binding) => binding.channelId === ch.id)) as channel (channel.id)}<option value={channel.id}>{channel.provider} · {channel.name}</option>{/each}
										</select>
										<button type="button" onclick={bindChannel} disabled={!selectedChannelId} class="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[5px] border border-border-subtle bg-bg-input px-3 text-[12px] font-medium text-text-primary transition-colors hover:bg-bg-hover disabled:opacity-50"><Plus class="h-3.5 w-3.5" /> {m.space_bind({}, { locale })}</button>
									</div>
								{/if}
							</div>
							{#if channelError}<p class="mt-2 text-[12px] text-error-soft break-words">{channelError}</p>{/if}
						</div>
						</section>

						<section id={sectionElementId("sandbox")} class="-scroll-mt-4 border-t border-border-subtle pt-10">
							<SandboxSettings settings={sandboxSettings} canManage={canManageSpaceSandbox} usage={space?.workspaceUsage} />
						</section>
					</div>
				{/if}
			</div>
		</main>
	</div>
</div>
