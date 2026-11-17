import type {
	GenerationParameterConstraint,
	GenerationPolicy,
	PublicGenerationDeclaration,
} from "@cohub/protocol/generation";
import { getCacheUserKey, getCacheUserKeyAsync } from "#lib/cache/keys.ts";
import { authStore } from "#lib/stores/auth.svelte.ts";
import {
	GENERATION_MODELS_CACHE_MAX_AGE_MS,
	getCachedGenerationModels,
	loadGenerationModels,
} from "#lib/stores/generation-models-cache.ts";

type NumericGenerationConstraint = { min?: number; max?: number };
type BooleanGenerationConstraint = { value?: boolean };

type PersistedGenerationPolicy = {
	mode: "auto" | "limited";
	models: string[];
	enumSelections: Record<string, Record<string, string[]>>;
	numericConstraints: Record<
		string,
		Record<string, NumericGenerationConstraint>
	>;
	booleanConstraints: Record<
		string,
		Record<string, BooleanGenerationConstraint>
	>;
};

export function createSessionGenerationPolicyController(options: {
	getActiveSessionId: () => string | null;
}) {
	let modelsCatalog = $state<PublicGenerationDeclaration[] | null>(null);
	let modelsCatalogUserKey = $state<string | null>(null);
	let modelsCatalogLoading = $state(false);
	let modelsCatalogLoaded = $state(false);
	let modelsCatalogError = $state<string | null>(null);
	let modelsCatalogRequest = 0;
	let mode = $state<"auto" | "limited">("auto");
	let selectedModels = $state<Set<string>>(new Set());
	let enumSelections = $state<Record<string, Record<string, Set<string>>>>({});
	let numericConstraints = $state<
		Record<string, Record<string, NumericGenerationConstraint>>
	>({});
	let booleanConstraints = $state<
		Record<string, Record<string, BooleanGenerationConstraint>>
	>({});

	function storageKey(sessionId: string) {
		return `cohub:generation-policy:${sessionId}`;
	}

	function serializeEnumSelections() {
		return Object.fromEntries(
			Object.entries(enumSelections).map(([model, parameters]) => [
				model,
				Object.fromEntries(
					Object.entries(parameters).map(([parameter, values]) => [
						parameter,
						[...values],
					]),
				),
			]),
		);
	}

	function sanitizeNumericConstraints(
		value: unknown,
	): Record<string, Record<string, NumericGenerationConstraint>> {
		if (!value || typeof value !== "object" || Array.isArray(value)) return {};
		return Object.fromEntries(
			Object.entries(value).map(([model, parameters]) => [
				model,
				Object.fromEntries(
					Object.entries(
						parameters &&
							typeof parameters === "object" &&
							!Array.isArray(parameters)
							? parameters
							: {},
					).flatMap(([parameter, rawConstraint]) => {
						if (
							!rawConstraint ||
							typeof rawConstraint !== "object" ||
							Array.isArray(rawConstraint)
						)
							return [];
						const constraint = rawConstraint as {
							min?: unknown;
							max?: unknown;
						};
						const next: NumericGenerationConstraint = {};
						if (
							typeof constraint.min === "number" &&
							Number.isFinite(constraint.min)
						)
							next.min = constraint.min;
						if (
							typeof constraint.max === "number" &&
							Number.isFinite(constraint.max)
						)
							next.max = constraint.max;
						return next.min === undefined && next.max === undefined
							? []
							: [[parameter, next]];
					}),
				),
			]),
		);
	}

	function sanitizeBooleanConstraints(
		value: unknown,
	): Record<string, Record<string, BooleanGenerationConstraint>> {
		if (!value || typeof value !== "object" || Array.isArray(value)) return {};
		return Object.fromEntries(
			Object.entries(value).map(([model, parameters]) => [
				model,
				Object.fromEntries(
					Object.entries(
						parameters &&
							typeof parameters === "object" &&
							!Array.isArray(parameters)
							? parameters
							: {},
					).flatMap(([parameter, rawConstraint]) => {
						if (
							!rawConstraint ||
							typeof rawConstraint !== "object" ||
							Array.isArray(rawConstraint)
						)
							return [];
						const value = (rawConstraint as { value?: unknown }).value;
						return typeof value === "boolean" ? [[parameter, { value }]] : [];
					}),
				),
			]),
		);
	}

	function load(sessionId: string): PersistedGenerationPolicy | null {
		try {
			const raw = localStorage.getItem(storageKey(sessionId));
			if (!raw) return null;
			const parsed = JSON.parse(raw) as Partial<PersistedGenerationPolicy>;
			return {
				mode: parsed.mode === "limited" ? "limited" : "auto",
				models: Array.isArray(parsed.models)
					? parsed.models.filter(
							(model): model is string => typeof model === "string",
						)
					: [],
				enumSelections: Object.fromEntries(
					Object.entries(parsed.enumSelections ?? {}).map(
						([model, parameters]) => [
							model,
							Object.fromEntries(
								Object.entries(parameters ?? {}).map(([parameter, values]) => [
									parameter,
									Array.isArray(values) ? values.map(String) : [],
								]),
							),
						],
					),
				),
				numericConstraints: sanitizeNumericConstraints(
					parsed.numericConstraints,
				),
				booleanConstraints: sanitizeBooleanConstraints(
					parsed.booleanConstraints,
				),
			};
		} catch {
			return null;
		}
	}

	function apply(policy: PersistedGenerationPolicy | null) {
		mode = policy?.mode ?? "auto";
		selectedModels = new Set(policy?.models ?? []);
		enumSelections = Object.fromEntries(
			Object.entries(policy?.enumSelections ?? {}).map(
				([model, parameters]) => [
					model,
					Object.fromEntries(
						Object.entries(parameters).map(([parameter, values]) => [
							parameter,
							new Set(values),
						]),
					),
				],
			),
		);
		numericConstraints = policy?.numericConstraints ?? {};
		booleanConstraints = policy?.booleanConstraints ?? {};
	}

	function save(sessionId: string) {
		localStorage.setItem(
			storageKey(sessionId),
			JSON.stringify({
				mode,
				models: [...selectedModels],
				enumSelections: serializeEnumSelections(),
				numericConstraints,
				booleanConstraints,
			} satisfies PersistedGenerationPolicy),
		);
	}

	function persistActive() {
		const sessionId = options.getActiveSessionId();
		if (!sessionId) return;
		save(sessionId);
	}

	async function loadModelsCatalog() {
		const request = ++modelsCatalogRequest;
		modelsCatalogLoading = true;
		modelsCatalogError = null;
		const userKey = await getCacheUserKeyAsync();
		if (request !== modelsCatalogRequest) return;

		if (modelsCatalogUserKey !== userKey) {
			modelsCatalog = null;
			modelsCatalogLoaded = false;
		}
		modelsCatalogUserKey = userKey;
		const cached = getCachedGenerationModels();
		if (cached.length > 0) {
			modelsCatalog = cached;
			modelsCatalogLoaded = true;
		}

		try {
			const loaded = await loadGenerationModels({
				maxAgeMs: GENERATION_MODELS_CACHE_MAX_AGE_MS,
			});
			if (request !== modelsCatalogRequest || getCacheUserKey() !== userKey)
				return;
			modelsCatalog = loaded;
			modelsCatalogLoaded = true;
		} catch (error) {
			if (request !== modelsCatalogRequest || getCacheUserKey() !== userKey)
				return;
			modelsCatalogLoaded = true;
			modelsCatalogError = "Create models could not be loaded.";
			console.error("Failed to load generation models catalog:", error);
		} finally {
			if (request === modelsCatalogRequest) modelsCatalogLoading = false;
		}
	}

	function buildTurnPolicy(): GenerationPolicy | null {
		if (mode !== "limited") return null;
		const models = [...selectedModels]
			.filter(
				(model) => modelsCatalog?.some((item) => item.model === model) ?? true,
			)
			.map((model) => {
				const declaration = modelsCatalog?.find((item) => item.model === model);
				const parameterPolicies: Record<string, GenerationParameterConstraint> =
					{};
				for (const [name, selectedValues] of Object.entries(
					enumSelections[model] ?? {},
				)) {
					const spec = declaration?.parameters?.[name];
					const enumValues =
						spec && "enum" in spec && Array.isArray(spec.enum) ? spec.enum : [];
					if (
						enumValues.length === 0 ||
						selectedValues.size >= enumValues.length
					)
						continue;
					const allowed = enumValues.filter((value) =>
						selectedValues.has(String(value)),
					);
					if (allowed.length > 0)
						parameterPolicies[name] = {
							kind: "enum",
							values: allowed as Array<string | number | boolean>,
						};
				}
				for (const [name, constraint] of Object.entries(
					numericConstraints[model] ?? {},
				)) {
					const spec = declaration?.parameters?.[name];
					const type = spec && "type" in spec ? spec.type : null;
					if (type !== "integer" && type !== "number") continue;
					const next: Extract<
						GenerationParameterConstraint,
						{ kind: "integer" | "number" }
					> = { kind: type === "integer" ? "integer" : "number" };
					if (constraint.min !== undefined) next.min = constraint.min;
					if (constraint.max !== undefined) next.max = constraint.max;
					if (next.min !== undefined || next.max !== undefined)
						parameterPolicies[name] = next;
				}
				for (const [name, constraint] of Object.entries(
					booleanConstraints[model] ?? {},
				)) {
					const spec = declaration?.parameters?.[name];
					if (!spec || !("type" in spec) || spec.type !== "boolean") continue;
					if (constraint.value !== undefined)
						parameterPolicies[name] = {
							kind: "boolean",
							value: constraint.value,
						};
				}
				return Object.keys(parameterPolicies).length > 0
					? { model, parameters: parameterPolicies }
					: { model };
			});
		return models.length > 0 ? { version: 1, mode: "limited", models } : null;
	}

	function getDefaultEnumSelections(
		model: PublicGenerationDeclaration,
	): Record<string, Set<string>> {
		const result: Record<string, Set<string>> = {};
		for (const [name, spec] of Object.entries(model.parameters ?? {})) {
			if ("enum" in spec && Array.isArray(spec.enum) && spec.enum.length > 0) {
				result[name] = new Set(spec.enum.map(String));
			}
		}
		return result;
	}

	function ensureModelEnumSelections(modelId: string) {
		const model = modelsCatalog?.find((item) => item.model === modelId);
		if (!model || enumSelections[modelId]) return;
		enumSelections = {
			...enumSelections,
			[modelId]: getDefaultEnumSelections(model),
		};
	}

	function setPolicyMode(nextMode: "auto" | "limited") {
		mode = nextMode;
		persistActive();
	}

	function setModelSelected(modelId: string, selected: boolean) {
		if (mode !== "limited") mode = "limited";
		const nextModels = new Set(selectedModels);
		if (selected) {
			nextModels.add(modelId);
			ensureModelEnumSelections(modelId);
		} else {
			nextModels.delete(modelId);
			const { [modelId]: _removedEnum, ...restEnum } = enumSelections;
			enumSelections = restEnum;
			const { [modelId]: _removedNumeric, ...restNumeric } = numericConstraints;
			numericConstraints = restNumeric;
			const { [modelId]: _removedBoolean, ...restBoolean } = booleanConstraints;
			booleanConstraints = restBoolean;
		}
		selectedModels = nextModels;
		persistActive();
	}

	function ensureModelSelectedForPolicy(modelId: string) {
		if (mode !== "limited") mode = "limited";
		if (!selectedModels.has(modelId)) {
			selectedModels = new Set([...selectedModels, modelId]);
		}
	}

	function setEnumValueSelected(
		modelId: string,
		parameter: string,
		value: string,
		selected: boolean,
	) {
		const model = modelsCatalog?.find((item) => item.model === modelId);
		if (!model) return;
		const base = enumSelections[modelId] ?? getDefaultEnumSelections(model);
		const nextValues = new Set(base[parameter] ?? []);
		if (selected) nextValues.add(value);
		else nextValues.delete(value);
		enumSelections = {
			...enumSelections,
			[modelId]: { ...base, [parameter]: nextValues },
		};
		ensureModelSelectedForPolicy(modelId);
		persistActive();
	}

	function setNumericConstraint(
		modelId: string,
		parameter: string,
		constraint: NumericGenerationConstraint,
	) {
		const nextConstraint: NumericGenerationConstraint = {};
		if (constraint.min !== undefined && Number.isFinite(constraint.min))
			nextConstraint.min = constraint.min;
		if (constraint.max !== undefined && Number.isFinite(constraint.max))
			nextConstraint.max = constraint.max;
		numericConstraints = {
			...numericConstraints,
			[modelId]: {
				...(numericConstraints[modelId] ?? {}),
				[parameter]: nextConstraint,
			},
		};
		ensureModelSelectedForPolicy(modelId);
		persistActive();
	}

	function setBooleanConstraint(
		modelId: string,
		parameter: string,
		constraint: BooleanGenerationConstraint,
	) {
		booleanConstraints = {
			...booleanConstraints,
			[modelId]: {
				...(booleanConstraints[modelId] ?? {}),
				[parameter]:
					constraint.value === undefined ? {} : { value: constraint.value },
			},
		};
		ensureModelSelectedForPolicy(modelId);
		persistActive();
	}

	function hasCurrentModelsIdentity() {
		return authStore.loaded && modelsCatalogUserKey === getCacheUserKey();
	}

	return {
		get modelsCatalog() {
			return hasCurrentModelsIdentity() ? modelsCatalog : null;
		},
		get modelsCatalogLoading() {
			return modelsCatalogLoading;
		},
		get modelsCatalogLoaded() {
			return hasCurrentModelsIdentity() && modelsCatalogLoaded;
		},
		get modelsCatalogError() {
			return hasCurrentModelsIdentity() ? modelsCatalogError : null;
		},
		get mode() {
			return mode;
		},
		get selectedModels() {
			return selectedModels;
		},
		get enumSelections() {
			return enumSelections;
		},
		get numericConstraints() {
			return numericConstraints;
		},
		get booleanConstraints() {
			return booleanConstraints;
		},
		load,
		apply,
		loadModelsCatalog,
		buildTurnPolicy,
		setPolicyMode,
		setModelSelected,
		setEnumValueSelected,
		setNumericConstraint,
		setBooleanConstraint,
	};
}
