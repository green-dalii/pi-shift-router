import type {
	AuthStore,
	ModelRegistryLike,
	ModelsStore,
	RegistryModelLike,
	StoredModel,
} from "./types.js";
import { flattenModels, getModelPricing, isProviderAuthenticated } from "./config.js";

/**
 * Model-source alignment with pi (SPEC §5.4).
 *
 * pi's `/model` lists `ctx.modelRegistry.getAvailable()` — the models of every
 * provider pi has CONFIGURED auth for (auth.json, env vars, models.json keys,
 * runtime/OAuth), drawn from pi's full composed catalog (bundled provider data
 * + models.json + availability cache). This module is the router's single
 * catalog entry point: registry first, local `models-store.json` only as a
 * fallback for contexts without a registry (headless, unit tests).
 *
 * Why it matters: the old store-only path listed 5 providers / 413 models on a
 * machine where pi offered 39 providers / 1354, and its auth heuristic
 * (`auth.json` + inline apiKey) could not see env-var or models.json-command
 * credentials — so the wizard showed a different, smaller list than `/model`.
 *
 * Structural types only: pi-ai is a transitive dependency of the pi host, not a
 * declared dependency of this package, so we duck-type the public registry API
 * (types live in `types.ts`, `ModelRegistryLike`) instead of importing pi-ai.
 */

export type { ModelRegistryLike, RegistryAuthStatusLike, RegistryModelLike } from "./types.js";

/** Everything the catalog helpers need. `registry` is optional by design. */
export interface ModelSourceInput {
	registry?: ModelRegistryLike;
	store: ModelsStore;
	auth?: AuthStore;
	env?: Record<string, string | undefined>;
}

/** Map a registry model onto the router's internal model shape. */
function toStoredModel(m: RegistryModelLike): StoredModel {
	const cost =
		typeof m.cost?.input === "number"
			? {
					input: m.cost.input,
					output: m.cost.output ?? 0,
					...(typeof m.cost.cacheRead === "number" ? { cacheRead: m.cost.cacheRead } : {}),
					...(typeof m.cost.cacheWrite === "number" ? { cacheWrite: m.cost.cacheWrite } : {}),
				}
			: undefined;
	return {
		id: m.id,
		provider: m.provider,
		...(m.name !== undefined ? { name: m.name } : {}),
		...(m.api !== undefined ? { api: m.api } : {}),
		...(m.baseUrl !== undefined ? { baseUrl: m.baseUrl } : {}),
		...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
		...(cost !== undefined ? { cost } : {}),
	};
}

/** Dedupe by `provider\0id` (same rule pi uses internally). */
function dedupe(models: StoredModel[]): StoredModel[] {
	const seen = new Map<string, StoredModel>();
	for (const m of models) seen.set(`${m.provider}\0${m.id}`, m);
	return [...seen.values()];
}

/**
 * The catalog shown by `/router config` — mirrors pi's `/model`:
 * registry-available models when a registry is present, else the merged
 * store filtered by the local auth heuristic.
 */
export function listAvailableModels(input: ModelSourceInput): StoredModel[] {
	const available = input.registry?.getAvailable?.();
	if (available) return dedupe(available.map(toStoredModel));
	const env = input.env ?? process.env;
	const auth = input.auth ?? {};
	return flattenModels(input.store).filter((m) => isProviderAuthenticated(m.provider, auth, input.store, env));
}

/** Is the provider usable — pi's auth status first, then the local heuristic. */
export function isProviderConfigured(input: ModelSourceInput, provider: string): boolean {
	const status = input.registry?.getProviderAuthStatus?.(provider);
	if (status) return status.configured;
	const env = input.env ?? process.env;
	return isProviderAuthenticated(provider, input.auth ?? {}, input.store, env);
}

/**
 * Is `provider/model` usable? With a registry this is pi's own verdict —
 * the model must exist AND its provider must be auth-configured (this is what
 * makes env-var / models.json-command credentials count, which the local
 * heuristic cannot see).
 */
export function isModelAvailable(input: ModelSourceInput, provider: string, modelId: string): boolean {
	const registry = input.registry;
	if (registry?.getAvailable) {
		// `find` may be absent in thin/structural registry stubs — fall back to
		// membership in pi's available list, which is what `/model` shows.
		const model =
			registry.find?.(provider, modelId) ??
			registry.getAvailable().find((m) => m.provider === provider && m.id === modelId);
		if (!model) return false;
		return registry.hasConfiguredAuth?.(model) ?? isProviderConfigured(input, provider);
	}
	return isProviderConfigured(input, provider) && (input.store[provider]?.models ?? []).some((m) => m.id === modelId);
}

/** Pricing (USD per 1M tokens): the registry's `Model.cost` wins, store as fallback. */
export function modelPricingFor(
	input: ModelSourceInput,
	provider: string,
	modelId: string,
): { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null {
	const cost = input.registry?.find?.(provider, modelId)?.cost;
	if (typeof cost?.input === "number") {
		return {
			input: cost.input,
			output: cost.output ?? 0,
			...(typeof cost.cacheRead === "number" ? { cacheRead: cost.cacheRead } : {}),
			...(typeof cost.cacheWrite === "number" ? { cacheWrite: cost.cacheWrite } : {}),
		};
	}
	return getModelPricing(input.store, provider, modelId);
}

/** Provider label for the UI — pi's display name when it has one. */
export function providerDisplayNameFor(input: ModelSourceInput, provider: string): string {
	return input.registry?.getProviderDisplayName?.(provider) ?? provider;
}

/**
 * Ask pi to re-read `models.json` before listing. Best-effort: a refresh
 * failure must never block the wizard (the previous snapshot is still valid).
 */
export async function refreshRegistry(registry?: ModelRegistryLike): Promise<void> {
	try {
		await registry?.refresh?.();
	} catch {
		// Errors are values: listing from the current snapshot is still correct.
	}
}
