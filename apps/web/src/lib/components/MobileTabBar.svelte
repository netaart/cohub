<script lang="ts">
import { CircleUserRound, LayoutGrid, MessageSquare } from "lucide-svelte";
import { page } from "$app/state";
import { getLocale } from "$lib/i18n/locale.svelte";
import { type MobileNavTab, resolveMobileNavTab } from "$lib/mobile-nav";
import { m } from "$lib/paraglide/messages.js";

const locale = $derived(getLocale());
const activeTab = $derived(resolveMobileNavTab(page.url.pathname));

const TABS = [
	{ id: "chats", icon: MessageSquare },
	{ id: "spaces", icon: LayoutGrid },
	{ id: "account", icon: CircleUserRound },
] as const satisfies readonly {
	id: MobileNavTab;
	icon: typeof MessageSquare;
}[];

function labelFor(tab: MobileNavTab) {
	switch (tab) {
		case "chats":
			return m.nav_tab_chats({}, { locale });
		case "spaces":
			return m.nav_tab_spaces({}, { locale });
		case "account":
			return m.nav_tab_account({}, { locale });
	}
}

function hrefFor(tab: MobileNavTab) {
	switch (tab) {
		case "chats":
			return "/sessions";
		case "spaces":
			return "/spaces";
		case "account":
			return "/settings/general";
	}
}
</script>

<nav
  class="flex h-[52px] shrink-0 items-stretch border-t border-border-subtle bg-bg-primary pb-[env(safe-area-inset-bottom)] lg:hidden"
  aria-label={m.nav_tabs_aria({}, { locale })}
>
  {#each TABS as tab (tab.id)}
    {@const active = activeTab === tab.id}
    <a
      href={hrefFor(tab.id)}
      class="group flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-[6px] px-1 transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 {active ? 'text-brand' : 'text-text-tertiary hover:text-text-secondary'}"
      aria-current={active ? "page" : undefined}
    >
      <tab.icon class="h-[18px] w-[18px] shrink-0" strokeWidth={active ? 2.1 : 1.8} />
      <span class="max-w-full truncate text-[10px] leading-none {active ? 'font-medium' : ''}">
        {labelFor(tab.id)}
      </span>
    </a>
  {/each}
</nav>
