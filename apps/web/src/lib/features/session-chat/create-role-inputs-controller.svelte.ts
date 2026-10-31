import type { PublicGenerationDeclaration } from "@cohub/protocol/generation";
import {
	generationParametersBlockedReason,
	generationRoleBlockedReason,
} from "$lib/generation-role-labels";
import { generationTextRoleFields } from "$lib/generation-text-roles";
import { getLocale } from "$lib/i18n/locale.svelte";
import {
	readCreateRoleDraft,
	writeCreateRoleDraft,
} from "$lib/stores/session-composer-drafts";

/**
 * Role boxes and parameters of the create-mode model. Kept per model, so
 * switching models does not discard what was typed, and persisted per space and
 * model, so a reload does not either.
 */
export function createCreateRoleInputsController(
	getModel: () => PublicGenerationDeclaration | null,
	getSpaceId: () => string,
) {
	let textsByModel = $state<Record<string, Record<string, string>>>({});
	let parametersByModel = $state<Record<string, Record<string, unknown>>>({});
	const storedByKey = new Map<string, ReturnType<typeof readCreateRoleDraft>>();

	const model = $derived(getModel());
	const fields = $derived(model ? generationTextRoleFields(model) : []);

	/** Read once per space and model; after the first edit the in-memory copy wins. */
	function stored() {
		const spaceId = getSpaceId();
		if (!model || !spaceId) return { texts: {}, parameters: {} };
		const key = `${spaceId}\n${model.model}`;
		let draft = storedByKey.get(key);
		if (!draft) {
			draft = readCreateRoleDraft(spaceId, model.model);
			storedByKey.set(key, draft);
		}
		return draft;
	}

	const texts = $derived.by(() => {
		if (!model) return {};
		return textsByModel[model.model] ?? stored().texts;
	});
	const savedParameters = $derived.by(() => {
		if (!model) return {};
		return parametersByModel[model.model] ?? stored().parameters;
	});
	const parameters = $derived.by(() => {
		if (!model) return {};
		if (model.allowUnknownParameters) return savedParameters;
		const declared = model.parameters ?? {};
		return Object.fromEntries(
			Object.entries(savedParameters).filter(([name]) => name in declared),
		);
	});
	const hasDraft = $derived(Object.values(texts).some((text) => text.trim()));
	const parametersReason = $derived(
		model && fields.length > 0
			? generationParametersBlockedReason(model, parameters, getLocale())
			: null,
	);
	const blockedReason = $derived(
		model && fields.length > 0
			? (generationRoleBlockedReason(model, texts, getLocale()) ??
					parametersReason)
			: null,
	);

	function persist(
		nextTexts: Record<string, string>,
		nextParameters: Record<string, unknown>,
	) {
		const spaceId = getSpaceId();
		if (!model || !spaceId) return;
		const draft = { texts: nextTexts, parameters: nextParameters };
		storedByKey.set(`${spaceId}\n${model.model}`, draft);
		writeCreateRoleDraft(spaceId, model.model, draft);
	}

	function setText(role: string, text: string) {
		if (!model) return;
		const next = { ...texts, [role]: text };
		textsByModel = { ...textsByModel, [model.model]: next };
		persist(next, savedParameters);
	}

	function setParameter(name: string, value: unknown) {
		if (!model) return;
		const next = { ...savedParameters, [name]: value };
		parametersByModel = { ...parametersByModel, [model.model]: next };
		persist(texts, next);
	}

	function clearParameter(name: string) {
		if (!model) return;
		const next = { ...savedParameters };
		delete next[name];
		parametersByModel = { ...parametersByModel, [model.model]: next };
		persist(texts, next);
	}

	return {
		get fields() {
			return fields;
		},
		get texts() {
			return texts;
		},
		get parameters() {
			return parameters;
		},
		get parameterSpecs() {
			return model?.parameters ?? {};
		},
		get hasDraft() {
			return hasDraft;
		},
		get blockedReason() {
			return blockedReason;
		},
		get parametersInvalid() {
			return parametersReason !== null;
		},
		setText,
		setParameter,
		clearParameter,
	};
}
