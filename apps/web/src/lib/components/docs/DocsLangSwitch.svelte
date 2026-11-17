<script lang="ts">
import { type DocsLocale, getDocsUi } from "#lib/docs/index.ts";

const {
	locale,
	alternateHref,
}: {
	locale: DocsLocale;
	alternateHref: string;
} = $props();

const ui = $derived(getDocsUi(locale));
</script>

<div
	class="inline-flex items-center rounded-[6px] border border-border-subtle bg-bg-input p-0.5 text-[11px] font-medium"
	role="group"
	aria-label={ui.language}
>
	<a
		href={locale === "en" ? undefined : alternateHref}
		class="rounded-[4px] px-2 py-1 transition-colors {locale === 'en'
			? 'bg-bg-content text-text-primary shadow-sm'
			: 'text-text-tertiary hover:text-text-secondary'}"
		aria-current={locale === "en" ? "true" : undefined}
	>
		{ui.english}
	</a>
	<a
		href={locale === "zh" ? undefined : alternateHref}
		class="rounded-[4px] px-2 py-1 transition-colors {locale === 'zh'
			? 'bg-bg-content text-text-primary shadow-sm'
			: 'text-text-tertiary hover:text-text-secondary'}"
		aria-current={locale === "zh" ? "true" : undefined}
	>
		{ui.chinese}
	</a>
</div>
