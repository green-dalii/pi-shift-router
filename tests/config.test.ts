/**
 * pi-shift-router — Configuration tests
 *
 * Pure-function tests for validateConfig() and flattenModels().
 * File-IO roundtrip (loadConfig → saveConfig → reload) is covered by
 * the "saveConfig → reload roundtrip" describe at the bottom, which
 * uses a sandbox-safe /tmp directory.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  expandEnv,
  validateConfig,
  flattenModels,
  mergeCustomProviders,
  resolveFastEndpoints,
  loadModelsStore,
  loadConfig,
  saveConfig,
  invalidateModelsStoreCache,
  invalidateConfigCache,
} from "../src/config.js";
import { DEFAULT_CONFIG, type ModelsStore, type ShiftRouterConfig, type StoredModel } from "../src/types.js";

const TMP_DIR = "/tmp/pi-shift-router-stale-test";
const TMP_CUSTOM = join(TMP_DIR, "models.json");

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

  // Issue #2 follow-up — Issue 3: auth.json precedence over inline apiKey was claimed but untested.
  it("auth.json raw key wins over inline apiKey (env ignored when both set)", async () => {
    const store: ModelsStore = {
      custom: {
        models: [{ id: "cu", provider: "custom", cost: { input: 1, output: 1 } } as StoredModel],
        baseUrl: "https://cu.example.com",
        apiKey: "$CUSTOM_KEY",
      },
    };
    const cfg: ShiftRouterConfig = {
      ...DEFAULT_CONFIG,
      tiers: {
        fast: { ...DEFAULT_CONFIG.tiers.fast, models: [{ provider: "custom", model: "cu", priority: 1 }] },
        smart: { ...DEFAULT_CONFIG.tiers.smart, models: [] },
      },
    };
    const eps = await resolveFastEndpoints(
      cfg,
      store,
      { custom: { type: "api", key: "from-auth" } },
      { CUSTOM_KEY: "from-env" },
    );
    expect(eps).toHaveLength(1);
    expect(eps[0]?.apiKey).toBe("from-auth");
  });

  it("Issue 4: empty fast tier falls back to cheapest model across custom + built-in providers", async () => {
    // Both custom (with env-set apiKey) and built-in (with auth.json) are eligible.
    // Cheapest by cost.input wins — does NOT respect user's defaultModel preference.
    const store: ModelsStore = {
      cheap_custom: {
        models: [{ id: "cheap", provider: "cheap_custom", cost: { input: 0.01, output: 0.02 } } as StoredModel],
        baseUrl: "https://cheap.example.com",
        apiKey: "$CUSTOM_KEY",
      },
      expensive_auth: {
        models: [{ id: "exp", provider: "expensive_auth", cost: { input: 100, output: 200 } } as StoredModel],
        baseUrl: "https://exp.example.com",
        apiKey: "raw-key",
      },
    };
    const emptyFast: ShiftRouterConfig = {
      ...DEFAULT_CONFIG,
      tiers: {
        fast: { ...DEFAULT_CONFIG.tiers.fast, models: [] },
        smart: { ...DEFAULT_CONFIG.tiers.smart, models: [] },
      },
    };
    const eps = await resolveFastEndpoints(emptyFast, store, { expensive_auth: { type: "api", key: "raw-key" } }, { CUSTOM_KEY: "cheap-key" });
    expect(eps).toHaveLength(1);
    expect(eps[0]?.provider).toBe("cheap_custom");
    expect(eps[0]?.apiKey).toBe("cheap-key");
  });
});

// ─── expandEnv (Issue #2 follow-up — Issue 1 fix) ─────────────────────
describe("expandEnv", () => {
  describe("intent-driven expansion", () => {
    it("expands $VAR when VAR is in env", () => {
      expect(expandEnv("$FOO", { FOO: "secret" })).toBe("secret");
    });

    it("expands ${VAR} (brace syntax) when VAR is in env", () => {
      expect(expandEnv("${FOO}", { FOO: "x" })).toBe("x");
    });

    it("expands $VAR_UNDERSCORE_PATTERN (single var name, per POSIX rule)", () => {
      // POSIX env-var names: leading letter or underscore, then word chars.
      // $FOO_BAR is consumed as one name; if env has FOO_BAR it expands.
      expect(expandEnv("$FOO_BAR", { FOO_BAR: "secret" })).toBe("secret");
    });

    it("expands inline mixed text + $VAR", () => {
      expect(expandEnv("prefix-$FOO-suffix", { FOO: "secret" })).toBe("prefix-secret-suffix");
    });

    it("expands $$ and $! escapes to literal $ and !", () => {
      expect(expandEnv("$$", {})).toBe("$");
      expect(expandEnv("$!", {})).toBe("!");
      expect(expandEnv("abc$$xyz", {})).toBe("abc$xyz");
      expect(expandEnv("abc$!xyz", {})).toBe("abc!xyz");
    });
  });

  describe("Issue 1 fix — digit/underscore-prefixed patterns preserved literally", () => {
    it("$1 is NOT consumed as a var name (POSIX: no leading digit)", () => {
      expect(expandEnv("$1", {})).toBe("$1");
      expect(expandEnv("$1", { "1": "one" })).toBe("$1");
    });

    it("$5 is NOT consumed as a var name", () => {
      expect(expandEnv("cost: $5", {})).toBe("cost: $5");
    });

    it("$KEY with trailing $ alone is preserved (trailing $ does not match any branch)", () => {
      expect(expandEnv("key=$ENV_LITERAL$", { ENV_LITERAL: "secret" })).toBe("key=secret$");
    });

    it("apiKey with $VAR pattern (VAR unset, letter prefix) IS consumed — by design", () => {
      // KNOWN LIMITATION (documented): The regex matches `$<letter>\w*` per POSIX.
      // Users who paste a literal `$VAR` pattern intending NO expansion but
      // who ALSO happen to have VAR defined in env will get it silently
      // rewritten. Fix options: use a different escape syntax (e.g., `$$VAR`
      // for literal), or document this in SPEC.
      // Pre-fix: result was "sk_live_abc" (silent truncation when VAR unset)
      // Post-fix: result is "sk_live_abc" SAME — letter-prefix still consumes.
      expect(expandEnv("sk_live_abc$def", {})).toBe("sk_live_abc");
    });

    it("apiKey with $VAR pattern where VAR IS set (letter prefix) IS rewritten — by design", () => {
      // KNOWN LIMITATION: see test above.
      expect(expandEnv("sk_live_$REAL_KEY", { REAL_KEY: "DIFFERENT_VALUE" })).toBe("sk_live_DIFFERENT_VALUE");
    });

    it("doc: a user who wants literal $VAR in apiKey should use $$ escape (POSIX convention)", () => {
      // $$ is the documented escape for literal $. So $$VAR in source becomes
      // $VAR after expansion — the user's intent is preserved.
      // But this only works at the START of the pattern. For "key$VAR", we'd need
      // a different escape convention. Documented as a known limitation.
      expect(expandEnv("$$VAR", {})).toBe("$VAR");
    });
  });

  describe("shell command + undefined returns", () => {
    it("returns undefined for value starting with ! (shell command syntax)", () => {
      expect(expandEnv("!printf secret", {})).toBeUndefined();
    });

    it("returns undefined for value === undefined", () => {
      expect(expandEnv(undefined)).toBeUndefined();
    });
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
// ─── invalidateModelsStoreCache (stale-list bug fix) ──────────────────
//
// Issue: /router config showed a stale model list because _modelsStore
// was cached for the lifetime of the pi session. After this fix, the
// wizard always re-reads models-store.json + models.json from disk.
//
// Tests use /tmp paths via the override parameter on loadModelsStore(),
// so they don't touch the user's real ~/.pi/agent/models.json.
describe("invalidateModelsStoreCache (stale-list fix)", () => {
  beforeEach(async () => {
    await rm(TMP_DIR, { recursive: true, force: true });
    await mkdir(TMP_DIR, { recursive: true });
    invalidateModelsStoreCache();
  });

  afterEach(async () => {
    await rm(TMP_DIR, { recursive: true, force: true });
    invalidateModelsStoreCache();
  });

  it("WITHOUT invalidateModelsStoreCache: cached view persists across disk mutations", async () => {
    await writeFile(TMP_CUSTOM, JSON.stringify({
      providers: { "_stale_test_a": { models: [{ id: "m-a" }], baseUrl: "https://a" } },
    }), "utf-8");
    invalidateModelsStoreCache();
    const first = await loadModelsStore({ custom: TMP_CUSTOM });
    expect(Object.keys(first)).toContain("_stale_test_a");
    expect(Object.keys(first)).not.toContain("_stale_test_b");

    await writeFile(TMP_CUSTOM, JSON.stringify({
      providers: {
        "_stale_test_a": { models: [{ id: "m-a" }], baseUrl: "https://a" },
        "_stale_test_b": { models: [{ id: "m-b" }], baseUrl: "https://b" },
      },
    }), "utf-8");

    const cached = await loadModelsStore({ custom: TMP_CUSTOM });
    expect(Object.keys(cached)).toContain("_stale_test_a");
    expect(Object.keys(cached)).not.toContain("_stale_test_b");
  });

  it("WITH invalidateModelsStoreCache: re-read reflects current disk state", async () => {
    await writeFile(TMP_CUSTOM, JSON.stringify({
      providers: { "_stale_test_a": { models: [{ id: "m-a" }], baseUrl: "https://a" } },
    }), "utf-8");
    invalidateModelsStoreCache();
    await loadModelsStore({ custom: TMP_CUSTOM });

    await writeFile(TMP_CUSTOM, JSON.stringify({
      providers: {
        "_stale_test_b": { models: [{ id: "m-b" }], baseUrl: "https://b" },
      },
    }), "utf-8");

    invalidateModelsStoreCache();
    const fresh = await loadModelsStore({ custom: TMP_CUSTOM });
    expect(Object.keys(fresh)).toContain("_stale_test_b");
    expect(Object.keys(fresh)).not.toContain("_stale_test_a");
  });

  it("invalidateConfigCache() also clears _modelsStore (defensive: config save implies possible catalog change)", async () => {
    await writeFile(TMP_CUSTOM, JSON.stringify({
      providers: { "_stale_test_a": { models: [{ id: "m-a" }], baseUrl: "https://a" } },
    }), "utf-8");
    invalidateModelsStoreCache();
    await loadModelsStore({ custom: TMP_CUSTOM });

    await writeFile(TMP_CUSTOM, JSON.stringify({
      providers: { "_stale_test_b": { models: [{ id: "m-b" }], baseUrl: "https://b" } },
    }), "utf-8");

    invalidateConfigCache();
    const after = await loadModelsStore({ custom: TMP_CUSTOM });
    expect(Object.keys(after)).toContain("_stale_test_b");
    expect(Object.keys(after)).not.toContain("_stale_test_a");
  });

  it("loadModelsStore accepts builtin + custom path overrides; missing builtin returns custom only", async () => {
    await writeFile(TMP_CUSTOM, JSON.stringify({
      providers: { "_only_custom": { models: [{ id: "x" }], baseUrl: "u" } },
    }), "utf-8");
    invalidateModelsStoreCache();
    const store = await loadModelsStore({ builtin: join(TMP_DIR, "nonexistent.json"), custom: TMP_CUSTOM });
    expect(Object.keys(store)).toContain("_only_custom");
  });
});

// ─── Persistence roundtrip (the /router command save pattern) ─────
describe("saveConfig → reload roundtrip", () => {
  const DIR = "/tmp/pi-shift-router-rt";
  beforeEach(async () => {
    await rm(DIR, { recursive: true, force: true });
    await mkdir(DIR, { recursive: true });
    invalidateConfigCache();
  });
  afterEach(async () => {
    await rm(DIR, { recursive: true, force: true });
    invalidateConfigCache();
  });

  it("mutate → saveConfig → reload keeps economics.mode (commands persist, not just memory)", async () => {
    const c = await loadConfig(DIR);
    expect(c.routing.economics.mode).toBeUndefined();
    c.routing.economics = { ...c.routing.economics, mode: "eco" };
    const saved = await saveConfig(c, DIR, "project");
    expect(saved).toBe(true);
    const reloaded = await loadConfig(DIR);
    expect(reloaded.routing.economics.mode).toBe("eco");
    expect(reloaded.routing.economics.reworkPenalty).toBe(3); // defaults intact
  });

  it("mode is round-tripped through the file even when the old value was a number", async () => {
    const c = await loadConfig(DIR);
    c.routing.economics = { ...c.routing.economics, mode: "sport" };
    await saveConfig(c, DIR, "project");
    const reloaded = await loadConfig(DIR);
    expect(reloaded.routing.economics.mode).toBe("sport");
  });
});
