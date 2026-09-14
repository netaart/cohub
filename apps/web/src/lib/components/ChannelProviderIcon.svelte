<script lang="ts">
import {
	MessageCircle,
	MessageSquare,
	MonitorPlay,
	Webhook,
} from "lucide-svelte";

type Size = "xxs" | "xs";

type Props = {
	provider?: string | null;
	size?: Size;
	class?: string;
};

let { provider = null, size = "xxs", class: className = "" }: Props = $props();

const normalized = $derived((provider ?? "").trim().toLowerCase());

const sizeClass = $derived(size === "xs" ? "h-5 w-5" : "h-4 w-4");
const iconClass = $derived(size === "xs" ? "h-3 w-3" : "h-2.5 w-2.5");

const toneClass = $derived.by(() => {
	if (normalized === "discord") {
		return "bg-provider-discord-bg text-provider-discord border-provider-discord-border";
	}
	if (normalized === "feishu") {
		return "bg-provider-feishu-bg text-provider-feishu border-provider-feishu-border";
	}
	if (normalized === "wechat") {
		return "bg-provider-wechat-bg text-provider-wechat border-provider-wechat-border";
	}
	return "bg-bg-elevated text-text-tertiary border-border-subtle";
});
</script>

<span
	class={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border ${sizeClass} ${toneClass} ${className}`}
	aria-hidden="true"
	title={normalized || "channel"}
>
	{#if normalized === "discord"}
		<MessageSquare class={iconClass} />
	{:else if normalized === "wechat" || normalized === "qq"}
		<MessageCircle class={iconClass} />
	{:else if normalized === "web"}
		<MonitorPlay class={iconClass} />
	{:else}
		<Webhook class={iconClass} />
	{/if}
</span>
