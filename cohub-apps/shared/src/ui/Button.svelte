<script lang="ts">
import type { Snippet } from "svelte";
import type { LucideIcon } from "./icon.ts";
import { LoaderCircle } from "lucide-svelte";

type Variant = "primary" | "brand" | "secondary" | "outline" | "ghost" | "danger";
type Props = {
  variant?: Variant;
  icon?: LucideIcon;
  loading?: boolean;
  disabled?: boolean;
  type?: "button" | "submit";
  href?: string;
  title?: string;
  block?: boolean;
  class?: string;
  onclick?: (event: MouseEvent) => void;
  children: Snippet;
};

let {
  variant = "secondary",
  icon: Icon,
  loading = false,
  disabled = false,
  type = "button",
  href,
  title,
  block = false,
  class: className = "",
  onclick,
  children,
}: Props = $props();

const tone: Record<Variant, string> = {
  primary: "bg-brand text-brand-contrast-fg hover:bg-brand-hover",
  brand: "bg-brand-muted text-brand hover:bg-brand-muted-hover",
  secondary: "bg-bg-elevated text-text-secondary hover:bg-bg-hover hover:text-text-primary",
  outline: "border border-border-subtle text-text-secondary hover:bg-bg-hover hover:text-text-primary",
  ghost: "text-text-tertiary hover:bg-bg-hover hover:text-text-primary",
  danger: "text-text-tertiary hover:bg-error-bg hover:text-error-soft",
};
const classes = $derived(
  `inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-[5px] px-3 py-2 text-[12px] font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 pointer-coarse:min-h-10 ${block ? "w-full sm:w-auto" : ""} ${tone[variant]} ${className}`,
);
</script>

{#snippet content()}
  {#if loading}<LoaderCircle class="h-3.5 w-3.5 animate-spin" />{:else if Icon}<Icon class="h-3.5 w-3.5" />{/if}
  <span>{@render children()}</span>
{/snippet}

{#if href}
  <a {href} {title} class={classes} target="_blank" rel="noopener noreferrer">{@render content()}</a>
{:else}
  <button {type} {title} class={classes} disabled={disabled || loading} aria-busy={loading || undefined} {onclick}>{@render content()}</button>
{/if}
