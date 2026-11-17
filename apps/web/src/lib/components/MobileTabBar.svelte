<script lang="ts">
import { APP_AREA_ICONS, appAreaLabel } from "#lib/components/app-area.ts";
import EntityIcon from "#lib/components/EntityIcon.svelte";
import UserAvatar from "#lib/components/UserAvatar.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { requestListScrollTop } from "#lib/layout/list-scroll-top.ts";
import { APP_AREAS, appAreaHref, resolveAppArea } from "#lib/mobile-nav.ts";
import { m } from "#lib/paraglide/messages.js";
import { authStore } from "#lib/stores/auth.svelte.ts";
import { page } from "$app/state";

const locale = $derived(getLocale());
const activeArea = $derived(resolveAppArea(page.url.pathname));
const profile = $derived(authStore.userUuid ? authStore.profile : null);

function onTabClick(event: MouseEvent, href: string) {
	if (page.url.pathname !== href) return;
	event.preventDefault();
	requestListScrollTop();
}
</script>

<nav
  class="flex h-[calc(52px+env(safe-area-inset-bottom,0px))] shrink-0 items-stretch border-t border-border-subtle/70 bg-bg-primary pb-[env(safe-area-inset-bottom,0px)] lg:hidden"
  aria-label={m.nav_tabs_aria({}, { locale })}
>
  {#each APP_AREAS as area (area)}
    {@const active = activeArea === area}
    {@const href = appAreaHref(area)}
    <a
      {href}
      onclick={(event) => onTabClick(event, href)}
      class="group flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-[8px] px-1 transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 {active ? 'text-brand' : 'text-text-tertiary hover:text-text-secondary'}"
      aria-current={active ? "page" : undefined}
    >
      {#if area === "account" && profile}
        <UserAvatar name={profile.displayName} avatarUrl={profile.avatarUrl} seed={authStore.userUuid} size="xs" class="h-[22px] w-[22px] border-0 ring-offset-1 ring-offset-bg-primary transition-shadow {active ? 'ring-[1.5px] ring-brand' : ''}" />
      {:else}
        <EntityIcon name={APP_AREA_ICONS[area]} class="h-[22px] w-[22px]" strokeWidth={active ? 2 : 1.75} />
      {/if}
      <span class="max-w-full truncate text-[11px] leading-none {active ? 'font-medium' : ''}">
        {appAreaLabel(area, locale)}
      </span>
    </a>
  {/each}
</nav>

