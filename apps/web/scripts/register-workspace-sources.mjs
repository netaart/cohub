import { registerHooks } from "node:module";

registerHooks({
	resolve(specifier, context, nextResolve) {
		const conditions = ["source", ...context.conditions];
		try {
			return nextResolve(specifier, { ...context, conditions });
		} catch (error) {
			if (
				error?.code !== "ERR_MODULE_NOT_FOUND" ||
				!specifier.startsWith(".") ||
				!specifier.endsWith(".js")
			)
				throw error;
			return nextResolve(`${specifier.slice(0, -3)}.ts`, {
				...context,
				conditions,
			});
		}
	},
});
