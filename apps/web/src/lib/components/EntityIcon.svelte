<script lang="ts" module>
import {
	AudioLines,
	CircleUserRound,
	Clock,
	Files,
	Film,
	Image as ImageIcon,
	Images,
	Layers,
	MessageSquare,
	PanelsTopLeft,
	Search,
	Settings,
} from "lucide-svelte";
import audio from "$lib/assets/pixel-icons/audio.svg";
import chat from "$lib/assets/pixel-icons/chat.svg";
import files from "$lib/assets/pixel-icons/files.svg";
import images from "$lib/assets/pixel-icons/images.svg";
import search from "$lib/assets/pixel-icons/search.svg";
import settings from "$lib/assets/pixel-icons/settings.svg";
import videos from "$lib/assets/pixel-icons/videos.svg";
import works from "$lib/assets/pixel-icons/works.svg";
import world from "$lib/assets/pixel-icons/world.svg";

type PixelArt = { src: string; cells: number };

const ENTITY_ICONS = {
	account: { line: CircleUserRound },
	apps: { line: PanelsTopLeft, pixel: { src: works, cells: 16 } },
	audio: { line: AudioLines, pixel: { src: audio, cells: 20 } },
	chat: { line: MessageSquare, pixel: { src: chat, cells: 16 } },
	files: { line: Files, pixel: { src: files, cells: 16 } },
	image: { line: ImageIcon, pixel: { src: images, cells: 20 } },
	media: { line: Images, pixel: { src: images, cells: 20 } },
	scheduled: { line: Clock },
	search: { line: Search, pixel: { src: search, cells: 16 } },
	settings: { line: Settings, pixel: { src: settings, cells: 16 } },
	spaces: { line: Layers, pixel: { src: world, cells: 16 } },
	video: { line: Film, pixel: { src: videos, cells: 20 } },
} satisfies Record<string, { line: typeof Search; pixel?: PixelArt }>;

export type EntityIconName = keyof typeof ENTITY_ICONS;
</script>

<script lang="ts">
const {
	name,
	class: className = "",
	strokeWidth,
}: {
	name: EntityIconName;
	class?: string;
	strokeWidth?: number;
} = $props();

const icon = $derived(ENTITY_ICONS[name]);
const pixel = $derived<PixelArt | undefined>(
	"pixel" in icon ? icon.pixel : undefined,
);
</script>

<span class="entity-icon {className}" aria-hidden="true">
	<icon.line class="entity-icon-line" {strokeWidth} />
	{#if pixel}
		<img
			class="entity-icon-pixel"
			src={pixel.src}
			alt=""
			width={pixel.cells}
			height={pixel.cells}
			draggable="false"
		/>
	{/if}
</span>
