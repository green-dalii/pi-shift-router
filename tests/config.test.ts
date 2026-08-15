/**
 * pi-shift-router — Configuration tests
 *
 * Pure-function tests for validateConfig() and flattenModels().
 * File-IO functions (loadConfig, saveConfig) are not tested here —
 * they require filesystem mocks which are out of scope for unit tests.
 */

import { describe, it, expect } from "vitest";
import { validateConfig, flattenModels, mergeCustomProviders, resolveFastEndpoints } from "../src/config.js";
import { DEFAULT_CONFIG, type ModelsStore, type ShiftRouterConfig, type StoredModel } from "../src/types.js";

function makeStore(): ModelsStore {
  return {
    deepseek: { models: [
      { id: "deepseek-v4-flash", provider: "deepseek" },
      { id: "deepseek-v4-pro", provider: "deepseek" },
    ] as StoredModel[] },
    kimi: { models: [
      { id: "kimi-k3", provider: "kimi" },
    ] as StoredModel[] },
  };
}

// ─── flattenModels ──────────────────────────────────────────────────
describe("flattenModels", () => {
  it("flattens a multi-provider store into a single array", () => {
    const flat = flattenModels(makeStore());
    const ids = flat.map((m) => m.id);
    expect(ids).toContain("deepseek-v4-flash");
    expect(ids).toContain("deepseek-v4-pro");
    expect(ids).toContain("kimi-k3");
    expect(flat.length).toBe(3);
  });

  it("injects the provider name into each model", () => {
    const flat = flattenModels(makeStore());
    for (const m of flat) {
      expect(typeof m.provider).toBe("string");
      expect(m.provider.length).toBeGreaterThan(0);
    }
    expect(flat.find((m) => m.id === "kimi-k3")?.provider).toBe("kimi");
  });

  it("returns empty array for empty store", () => {
    expect(flattenModels({})).toEqual([]);
  });

  it("skips providers with empty models array", () => {
    const flat = flattenModels({
      empty: { models: [] },
      deepseek: { models: [{ id: "x", provider: "deepseek" } as StoredModel] },
    });
    expect(flat.length).toBe(1);
    expect(flat[0]?.id).toBe("x");
  });
});

// ─── mergeCustomProviders ───────────────────────────────────────────
describe("mergeCustomProviders", () => {
  it("adds custom providers on top of the built-in catalog", () => {
    const builtin: ModelsStore = {
      deepseek: { models: [{ id: "deepseek-v4-flash", provider: "deepseek" } as StoredModel] },
    };
    const merged = mergeCustomProviders(builtin, {
      providers: {
        agnes: {
          models: [{ id: "agnes-2.5-flash", provider: "agnes" } as StoredModel],
          baseUrl: "https://api.example.com/v1",
          apiKey: "$AI_API_KEY",
        },
      },
    });
    expect(merged.deepseek.models[0]?.id).toBe("deepseek-v4-flash");
    expect(merged.agnes.baseUrl).toBe("https://api.example.com/v1");
    expect(merged.agnes.apiKey).toBe("$AI_API_KEY");
  });

  it("custom models are upserted by id, keeping built-in models", () => {
    const builtin: ModelsStore = {
      agnes: { models: [{ id: "old", provider: "agnes" } as StoredModel] },
    };
    const merged = mergeCustomProviders(builtin, {
      providers: {
        agnes: {
          models: [
            { id: "new", provider: "agnes" } as StoredModel,
            { id: "old", name: "replaced" } as StoredModel,
          ],
        },
      },
    });
    expect(merged.agnes.models.map((m) => m.id).sort()).toEqual(["new", "old"]);
    expect(merged.agnes.models.find((m) => m.id === "old")?.name).toBe("replaced");
  });

  it("empty custom providers leaves the built-in catalog intact", () => {
    const builtin: ModelsStore = { deepseek: { models: [] } };
    expect(mergeCustomProviders(builtin, {})).toEqual(builtin);
  });
});

// ─── resolveFastEndpoints (custom provider auth) ────────────────────
describe("resolveFastEndpoints", () => {
  it("resolves a custom provider via inline apiKey with env expansion", async () => {
    const store: ModelsStore = {
      agnes: {
        models: [{ id: "agnes-2.5-flash", provider: "agnes" } as StoredModel],
        baseUrl: "https://api.example.com/v1",
        api: "openai-responses",
        apiKey: "$SR_TEST_KEY",
      },
    };
    const cfg: ShiftRouterConfig = {
      ...DEFAULT_CONFIG,
      tiers: {
        fast: { ...DEFAULT_CONFIG.tiers.fast, models: [{ provider: "agnes", model: "agnes-2.5-flash", priority: 1 }] },
        smart: { ...DEFAULT_CONFIG.tiers.smart, models: [] },
      },
    };
    const eps = await resolveFastEndpoints(cfg, store, {}, { SR_TEST_KEY: "test-key-123" });
    expect(eps).toHaveLength(1);
    expect(eps[0]).toMatchObject({
      provider: "agnes",
      modelId: "agnes-2.5-flash",
      baseUrl: "https://api.example.com/v1",
      apiType: "openai-responses",
      apiKey: "test-key-123",
    });
  });

  it("skips providers whose apiKey is a shell command or an unset env var", async () => {
    const store: ModelsStore = {
      agnes: {
        models: [{ id: "agnes-2.5-flash", provider: "agnes" } as StoredModel],
        baseUrl: "https://api.example.com/v1",
        apiKey: "!printf secret",
      },
      kimi: {
        models: [{ id: "kimi-k3", provider: "kimi" } as StoredModel],
        baseUrl: "https://api.example.com/v1",
        apiKey: "$SR_UNSET_KEY",
      },
    };
    const cfg: ShiftRouterConfig = {
      ...DEFAULT_CONFIG,
      tiers: {
        fast: {
          ...DEFAULT_CONFIG.tiers.fast,
          models: [
            { provider: "agnes", model: "agnes-2.5-flash", priority: 1 },
            { provider: "kimi", model: "kimi-k3", priority: 2 },
          ],
        },
        smart: { ...DEFAULT_CONFIG.tiers.smart, models: [] },
      },
    };
    expect(await resolveFastEndpoints(cfg, store, {}, {})).toEqual([]);
  });

  it("expands $$ and $! escapes to literal $ and !", async () => {
    const store: ModelsStore = {
      agnes: {
        models: [{ id: "agnes-2.5-flash", provider: "agnes" } as StoredModel],
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-$$x$!y",
      },
    };
    const cfg: ShiftRouterConfig = {
      ...DEFAULT_CONFIG,
      tiers: {
        fast: {
          ...DEFAULT_CONFIG.tiers.fast,
          models: [{ provider: "agnes", model: "agnes-2.5-flash", priority: 1 }],
        },
        smart: { ...DEFAULT_CONFIG.tiers.smart, models: [] },
      },
    };
    const eps = await resolveFastEndpoints(cfg, store, {}, {});
    expect(eps).toHaveLength(1);
    expect(eps[0]?.apiKey).toBe("sk-$x!y");
  });
});

// ─── validateConfig ─────────────────────────────────────────────────
describe("validateConfig", () => {
  it("returns no warnings when all referenced models exist", () => {
    const cfg: ShiftRouterConfig = {
      ...DEFAULT_CONFIG,
      tiers: {
        fast: {
          ...DEFAULT_CONFIG.tiers.fast,
          models: [{ provider: "deepseek", model: "deepseek-v4-flash", priority: 1 }],
        },
        smart: {
          ...DEFAULT_CONFIG.tiers.smart,
          models: [{ provider: "kimi", model: "kimi-k3", priority: 1 }],
        },
      },
    };
    expect(validateConfig(cfg, makeStore())).toEqual([]);
  });

  it("no warnings when tiers are empty (default state)", () => {
    expect(validateConfig(DEFAULT_CONFIG, makeStore())).toEqual([]);
  });

  it("warns when a provider is not in the store", () => {
    const cfg: ShiftRouterConfig = {
      ...DEFAULT_CONFIG,
      tiers: {
        fast: {
          ...DEFAULT_CONFIG.tiers.fast,
          models: [{ provider: "unknown-provider", model: "x", priority: 1 }],
        },
        smart: { ...DEFAULT_CONFIG.tiers.smart, models: [] },
      },
    };
    const warnings = validateConfig(cfg, makeStore());
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/unknown-provider/);
    expect(warnings[0]).toMatch(/fast/);
  });

  it("warns when a model is not in the provider", () => {
    const cfg: ShiftRouterConfig = {
      ...DEFAULT_CONFIG,
      tiers: {
        fast: {
          ...DEFAULT_CONFIG.tiers.fast,
          models: [{ provider: "deepseek", model: "nonexistent-model", priority: 1 }],
        },
        smart: { ...DEFAULT_CONFIG.tiers.smart, models: [] },
      },
    };
    const warnings = validateConfig(cfg, makeStore());
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/nonexistent-model/);
    expect(warnings[0]).toMatch(/deepseek/);
  });

  it("warns when same model appears in both tiers (routing becomes no-op)", () => {
    const cfg: ShiftRouterConfig = {
      ...DEFAULT_CONFIG,
      tiers: {
        fast: {
          ...DEFAULT_CONFIG.tiers.fast,
          models: [{ provider: "deepseek", model: "deepseek-v4-flash", priority: 1 }],
        },
        smart: {
          ...DEFAULT_CONFIG.tiers.smart,
          models: [{ provider: "deepseek", model: "deepseek-v4-flash", priority: 1 }],
        },
      },
    };
    const warnings = validateConfig(cfg, makeStore());
    expect(warnings.some((w) => w.includes("both"))).toBe(true);
  });

  it("accumulates multiple warnings, not just the first", () => {
    const cfg: ShiftRouterConfig = {
      ...DEFAULT_CONFIG,
      tiers: {
        fast: {
          ...DEFAULT_CONFIG.tiers.fast,
          models: [
            { provider: "unknown-a", model: "x", priority: 1 },
            { provider: "deepseek", model: "nonexistent", priority: 2 },
          ],
        },
        smart: { ...DEFAULT_CONFIG.tiers.smart, models: [] },
      },
    };
    const warnings = validateConfig(cfg, makeStore());
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });
});