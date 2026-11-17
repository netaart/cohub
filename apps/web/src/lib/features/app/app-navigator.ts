import type {
	AppNavigationOpenMessage,
	AppNavigationOpenResponse,
} from "@cohub/protocol/app-navigation";
import type { resolveAppNavigation } from "./app-open.ts";

type AppTarget = Extract<AppNavigationOpenMessage["target"], { kind: "app" }>;
type ResolvedApp = Awaited<ReturnType<typeof resolveAppNavigation>>;
type OpenResult = Pick<
	AppNavigationOpenResponse,
	"handled" | "reason" | "call"
>;

export function createAppNavigator(options: {
	getContext: () => string;
	resolve: (target: AppTarget) => Promise<ResolvedApp>;
	open: (
		resolved: ResolvedApp,
		message: AppNavigationOpenMessage,
		isCurrent: () => boolean,
	) => Promise<OpenResult>;
}) {
	let generation = 0;
	let activeTarget = "";
	const pending = new Map<string, Promise<OpenResult>>();
	return {
		cancel() {
			generation += 1;
			activeTarget = "";
			pending.clear();
		},
		async open(message: AppNavigationOpenMessage): Promise<OpenResult> {
			if (message.target.kind !== "app")
				return { handled: false, reason: "unsupported" };
			const target = message.target;
			const key = JSON.stringify([options.getContext(), target]);
			if (activeTarget !== key) {
				generation += 1;
				activeTarget = key;
				pending.clear();
			}
			if (!message.call) {
				const existing = pending.get(key);
				if (existing) return existing;
			}
			const requestGeneration = generation;
			const context = options.getContext();
			const current = () =>
				requestGeneration === generation &&
				context === options.getContext() &&
				activeTarget === key;
			const request = (async (): Promise<OpenResult> => {
				try {
					const resolved = await options.resolve(target);
					if (!current()) return { handled: true };
					if (
						resolved.detail.app.status === "disabled" ||
						!resolved.detail.content
					)
						return { handled: false, reason: "inaccessible" };
					return await options.open(resolved, message, current);
				} catch {
					return current()
						? { handled: false, reason: "inaccessible" }
						: { handled: true };
				}
			})().finally(() => {
				if (pending.get(key) === request) pending.delete(key);
			});
			if (!message.call) pending.set(key, request);
			return request;
		},
	};
}
