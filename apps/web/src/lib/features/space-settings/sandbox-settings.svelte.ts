import type {
	SandboxSpecId,
	SpaceConfigInput,
	SpaceSandboxConfig,
	SpaceSandboxRecord,
} from "@neta-art/cohub";
import { sdk } from "$lib/sdk";
import { cacheSpaceRecordSoon } from "$lib/stores/space-record-cache";

export type SandboxSpecOption = {
	id: SandboxSpecId;
	rank: number;
	label: string;
	description: string;
	requiredPlan: string | null;
	resources: {
		limits: Record<string, string>;
		requests: Record<string, string>;
	};
};

export type SandboxConfigPatch = NonNullable<SpaceConfigInput["sandbox"]>;

export class SandboxSettingsState {
	sandbox = $state<SpaceSandboxRecord | null>(null);
	config = $state<SpaceSandboxConfig | null>(null);

	constructor(readonly spaceId: string) {}

	get specs(): Record<string, SandboxSpecOption> {
		return (this.config?.specs ?? {}) as Record<string, SandboxSpecOption>;
	}

	async load() {
		const space = sdk.space(this.spaceId);
		const [sandbox, config] = await Promise.all([
			space.sandbox
				.get()
				.then((result) => result.sandbox)
				.catch(() => undefined),
			space
				.getConfig()
				.then((result) => result.config.sandbox)
				.catch(() => undefined),
		]);
		if (sandbox !== undefined) this.sandbox = sandbox;
		if (config) this.config = config;
	}

	async update(
		patch: SandboxConfigPatch,
		optimistic?: Partial<SpaceSandboxConfig>,
	) {
		const previous = this.config;
		if (optimistic && this.config)
			this.config = { ...this.config, ...optimistic };
		try {
			const result = await sdk
				.space(this.spaceId)
				.updateConfig({ sandbox: patch });
			cacheSpaceRecordSoon(result.space);
			return result;
		} catch (error) {
			if (optimistic) this.config = previous;
			throw error;
		} finally {
			await this.load();
		}
	}

	async restart() {
		const result = await sdk.space(this.spaceId).sandbox.recreate();
		await this.load();
		return result;
	}
}
