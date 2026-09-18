import { describe, it, expect } from "vitest";
import {
	listAvailableModels,
	isProviderConfigured,
	isModelAvailable,
	modelPricingFor,
	providerDisplayNameFor,
	refreshRegistry,
	type ModelRegistryLike,
} from "../src/model-source.js";
import type { ModelsStore, AuthStore } from "../src/types.js";

/** Store used as the FALLBACK path only — deliberately missing the registry model. */
const store: ModelsStore = {
	legacy: {
		models: [{ id: "legacy-model", provider: "legacy", cost: { input: 1, output: 2 } }],
	},
	openrouter: {
		models: [{ id: "store-only", provider: "openrouter", cost: { input: 3, output: 4 } }],
	},
	ghost: {
		models: [{ id: "ghost-model", provider: "ghost", cost: { input: 9, output: 9 } }],
	},
};

const auth: AuthStore = {
	legacy: { type: "api_key", key: "sk-legacy" },
	openrouter: { type: "api_key", key: "sk-openrouter" },
};

function registryWith(
	available: Array<Record<string, unknown>>,
	extra: Partial<ModelRegistryLike> = {},
): ModelRegistryLike {
	return { getAvailable: () => available as any, ...extra };
}

describe("model-source — pi registry is the catalog source", () => {
	it("lists the registry's models, including ones the store never had (no drift)", () => {
		const registry = registryWith([
			{ id: "registry-only", provider: "openrouter", cost: { input: 5, output: 6, cacheRead: 1, cacheWrite: 2 } },
			{ id: "store-only", provider: "openrouter", cost: { input: 3, output: 4 } },
		]);

		const list = listAvailableModels({ registry, store, auth });
		const keys = list.map((m) => `${m.provider}/${m.id}`);

		expect(keys).toEqual(["openrouter/registry-only", "openrouter/store-only"]);
		expect(keys).not.toContain("legacy/legacy-model"); // registry is authoritative, not the store
		expect(list[0].cost).toEqual({ input: 5, output: 6, cacheRead: 1, cacheWrite: 2 });
	});

	it("keeps registry cost + contextWindow metadata", () => {
		const registry = registryWith([
			{ id: "m1", provider: "p", contextWindow: 200_000, api: "anthropic-messages", cost: { input: 1, output: 2 } },
		]);
		const [m] = listAvailableModels({ registry, store: {}, auth: {} });
		expect(m.contextWindow).toBe(200_000);
		expect(m.api).toBe("anthropic-messages");
	});

	it("dedupes by provider/id (a model duplicated across registry entries appears once)", () => {
		const registry = registryWith([
			{ id: "dup", provider: "p", cost: { input: 1, output: 1 } },
			{ id: "dup", provider: "p", cost: { input: 1, output: 1 } },
		]);
		expect(listAvailableModels({ registry, store: {}, auth: {} })).toHaveLength(1);
	});

	it("survives a registry that has no models (empty list, no crash)", () => {
		const registry = registryWith([]);
		expect(listAvailableModels({ registry, store, auth })).toEqual([]);
	});

	it("falls back to the store when no registry is present (headless / tests)", () => {
		const list = listAvailableModels({ store, auth });
		const keys = list.map((m) => `${m.provider}/${m.id}`);
		// legacy + openrouter are auth'd (auth.json), ghost is not → the store path keeps the auth filter
		expect(keys.sort()).toEqual(["legacy/legacy-model", "openrouter/store-only"]);
	});
});

describe("model-source — auth follows pi's registry, not auth.json alone", () => {
	it("treats a registry-configured provider as configured even without an auth.json key", () => {
		const registry = registryWith([{ id: "codex-1", provider: "openai" }], {
			getProviderAuthStatus: (provider: string) =>
				provider === "openai" ? { configured: true, source: "environment" } : { configured: false },
		});

		expect(isProviderConfigured({ registry, store, auth }, "openai")).toBe(true);
		expect(isModelAvailable({ registry, store, auth }, "openai", "codex-1")).toBe(true);
		// ...while an unconfigured provider stays unavailable
		expect(isProviderConfigured({ registry, store, auth }, "ghost")).toBe(false);
	});

	it("uses hasConfiguredAuth for a known model when provider status is absent", () => {
		const model = { id: "m", provider: "p" };
		const registry = registryWith([model], {
			find: (provider: string, id: string) => (provider === "p" && id === "m" ? (model as any) : undefined),
			hasConfiguredAuth: () => true,
		});
		expect(isModelAvailable({ registry, store, auth }, "p", "m")).toBe(true);
	});

	it("reports a model missing from the registry as unavailable", () => {
		const registry = registryWith([{ id: "other", provider: "p" }], {
			find: () => undefined,
			getProviderAuthStatus: () => ({ configured: true }),
		});
		expect(isModelAvailable({ registry, store, auth }, "p", "nope")).toBe(false);
	});

	it("falls back to auth.json + inline apiKey when no registry is present", () => {
		expect(isProviderConfigured({ store, auth }, "legacy")).toBe(true);
		expect(isProviderConfigured({ store, auth }, "ghost")).toBe(false);
		expect(
			isProviderConfigured({ store: { ghost: { models: [], apiKey: "sk-inline" } }, auth: {} }, "ghost"),
		).toBe(true);
	});
});

describe("model-source — pricing prefers the registry", () => {
	const registry = registryWith([], {
		find: (provider: string, id: string) =>
			provider === "openrouter" && id === "store-only"
				? ({ id, provider, cost: { input: 7, output: 8, cacheRead: 0.7, cacheWrite: 0.8 } } as any)
				: undefined,
	});

	it("returns registry cost when the model is there", () => {
		expect(modelPricingFor({ registry, store, auth }, "openrouter", "store-only")).toEqual({
			input: 7,
			output: 8,
			cacheRead: 0.7,
			cacheWrite: 0.8,
		});
	});

	it("falls back to store pricing when the registry has no entry", () => {
		expect(modelPricingFor({ store, auth }, "openrouter", "store-only")).toEqual({
			input: 3,
			output: 4,
		});
	});

	it("returns null when neither source has pricing", () => {
		expect(modelPricingFor({ registry, store, auth }, "nobody", "nothing")).toBeNull();
	});
});

describe("model-source — helpers", () => {
	it("refreshRegistry awaits refresh() and tolerates its absence", async () => {
		let called = 0;
		await refreshRegistry({ refresh: async () => { called += 1; } });
		await refreshRegistry({});
		await refreshRegistry(undefined);
		expect(called).toBe(1);
	});

	it("refreshRegistry swallows a refresh failure (listing must still work)", async () => {
		await expect(
			refreshRegistry({ refresh: async () => { throw new Error("boom"); } }),
		).resolves.toBeUndefined();
	});

	it("providerDisplayNameFor prefers pi's display name, else the raw id", () => {
		const registry = registryWith([], { getProviderDisplayName: (p: string) => (p === "zai" ? "Z.AI" : p) });
		expect(providerDisplayNameFor({ registry, store, auth }, "zai")).toBe("Z.AI");
		expect(providerDisplayNameFor({ store, auth }, "zai")).toBe("zai");
	});
});
