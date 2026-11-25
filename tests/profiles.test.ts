/**
 * pi-shift-router — Per-session profiles (SPEC §9.6)
 *
 * A profile is a named preset of tier chains; the SELECTION is session state.
 * These tests pin the contract:
 *   - one merge point (`applyProfile`), pure, never mutating the base
 *   - replace, not append
 *   - an unknown profile changes nothing
 *   - the router resolves models through the EFFECTIVE config
 *   - the selection lives in RouterState (never module scope)
 *   - selecting a profile writes NOTHING to disk
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

// Hermetic isolation: config.ts computes PI_AGENT_DIR from homedir() at
// module scope, so the real ~/.pi/agent/pi-shift-router.json would leak into
// every loadConfig() here.
vi.mock("node:os", () => ({ homedir: () => "/tmp/pi-shift-router-profiles-home" }));

import { applyProfile, listProfiles, loadConfig, saveConfig, invalidateConfigCache } from "../src/config.js";
import { describeActiveProfile } from "../src/commands.js";
import { DEFAULT_CONFIG, type ModelRef, type ShiftRouterConfig } from "../src/types.js";
import { createRouterState } from "../src/router.js";
import { processRoute } from "../src/router.js";
import { findBestModelForTier } from "../src/tier.js";
import { findTierForModel } from "../src/failover.js";

const USER_HOME = "/tmp/pi-shift-router-profiles-home";
const USER_CONFIG = join(USER_HOME, ".pi", "agent", "pi-shift-router.json");

function ref(provider: string, model: string, priority = 1): ModelRef {
  return { provider, model, priority };
}

/** A base config with two distinct chains per tier. */
function makeBase(profiles?: Record<string, { fast?: ModelRef[]; smart?: ModelRef[] }>): ShiftRouterConfig {
  const base: ShiftRouterConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  base.tiers.fast.models = [ref("anthropic", "haiku")];
  base.tiers.smart.models = [ref("anthropic", "opus")];
  if (profiles) base.profiles = profiles;
  return base;
}

const REGISTRY = {
  find: (provider: string, modelId: string) =>
    [
      { provider: "anthropic", id: "haiku" },
      { provider: "anthropic", id: "sonnet" },
      { provider: "anthropic", id: "opus" },
    ].find((m) => m.provider === provider && m.id === modelId),
};

// ─── applyProfile — the single merge point ─────────────────────────

describe("applyProfile", () => {
  it("returns the base by identity when no profile is selected", () => {
    const base = makeBase();
    expect(applyProfile(base, null)).toBe(base);
    expect(applyProfile(base, undefined)).toBe(base);
  });

  it("returns the base unchanged for an unknown profile name", () => {
    const base = makeBase({ known: { fast: [ref("anthropic", "sonnet")] } });
    const effective = applyProfile(base, "nope");
    expect(effective.tiers.fast.models).toEqual(base.tiers.fast.models);
    expect(effective.tiers.smart.models).toEqual(base.tiers.smart.models);
  });

  it("returns the base unchanged when no profiles are defined at all", () => {
    const base = makeBase();
    expect(applyProfile(base, "anything")).toBe(base);
  });

  it("replaces the Fast chain wholesale", () => {
    const base = makeBase({ p: { fast: [ref("anthropic", "sonnet", 1), ref("anthropic", "haiku", 2)] } });
    const effective = applyProfile(base, "p");
    expect(effective.tiers.fast.models.map((m) => m.model)).toEqual(["sonnet", "haiku"]);
  });

  it("keeps the Smart chain when the profile omits it", () => {
    const base = makeBase({ p: { fast: [ref("anthropic", "sonnet")] } });
    const effective = applyProfile(base, "p");
    expect(effective.tiers.smart.models).toEqual(base.tiers.smart.models);
  });

  it("replaces the Smart chain when the profile names it", () => {
    const base = makeBase({ p: { smart: [ref("anthropic", "sonnet")] } });
    const effective = applyProfile(base, "p");
    expect(effective.tiers.smart.models.map((m) => m.model)).toEqual(["sonnet"]);
    expect(effective.tiers.fast.models).toEqual(base.tiers.fast.models);
  });

  it("never mutates the base config", () => {
    const base = makeBase({ p: { fast: [ref("anthropic", "sonnet")], smart: [ref("anthropic", "opus")] } });
    const before = JSON.stringify(base);
    applyProfile(base, "p");
    expect(JSON.stringify(base)).toBe(before);
  });

  it("does not alias the base's model arrays", () => {
    const base = makeBase({ p: { fast: [ref("anthropic", "sonnet")] } });
    const effective = applyProfile(base, "p");
    effective.tiers.fast.models.push(ref("anthropic", "opus"));
    expect(base.tiers.fast.models.map((m) => m.model)).toEqual(["haiku"]);
  });

  it("copies the profile's model refs so later edits cannot leak in", () => {
    const base = makeBase({ p: { fast: [ref("anthropic", "sonnet")] } });
    const effective = applyProfile(base, "p");
    effective.tiers.fast.models[0]!.model = "mutated";
    expect(base.profiles!.p!.fast![0]!.model).toBe("sonnet");
  });

  it("leaves non-tier config untouched", () => {
    const base = makeBase({ p: { fast: [ref("anthropic", "sonnet")] } });
    const effective = applyProfile(base, "p");
    expect(effective.routing).toBe(base.routing);
    expect(effective.ux).toBe(base.ux);
    expect(effective.orchestration).toBe(base.orchestration);
    expect(effective.enabled).toBe(base.enabled);
  });
});

// ─── listProfiles ──────────────────────────────────────────────────

describe("listProfiles", () => {
  it("returns an empty list when no profiles are defined", () => {
    expect(listProfiles(makeBase())).toEqual([]);
  });

  it("returns the defined profile names", () => {
    const base = makeBase({ alpha: {}, beta: { fast: [] } });
    expect(listProfiles(base).sort()).toEqual(["alpha", "beta"]);
  });
});

// ─── describeActiveProfile ─────────────────────────────────────────

describe("describeActiveProfile", () => {
  it("says none when no profile is selected", () => {
    expect(describeActiveProfile(null, ["a"])).toBe("none");
  });

  it("names the active profile", () => {
    expect(describeActiveProfile("a", ["a", "b"])).toBe("a");
  });

  it("flags a profile that is no longer defined", () => {
    expect(describeActiveProfile("gone", ["a"])).toContain("no longer defined");
  });
});

// ─── The router resolves through the EFFECTIVE config ──────────────

describe("profile-aware model resolution", () => {
  it("resolves the Fast tier from the profile's chain", () => {
    const base = makeBase({ p: { fast: [ref("anthropic", "sonnet")] } });
    const effective = applyProfile(base, "p");
    const resolved = findBestModelForTier("fast", effective, REGISTRY);
    expect(resolved?.modelId).toBe("sonnet");
  });

  it("resolves the base chain when no profile is selected", () => {
    const base = makeBase({ p: { fast: [ref("anthropic", "sonnet")] } });
    const resolved = findBestModelForTier("fast", base, REGISTRY);
    expect(resolved?.modelId).toBe("haiku");
  });

  it("classifies a profile-only model into its tier", () => {
    const base = makeBase({ p: { fast: [ref("anthropic", "sonnet")] } });
    const effective = applyProfile(base, "p");
    expect(findTierForModel(effective, "anthropic", "sonnet")).toBe("fast");
  });

  it("no longer classifies a base-only model into the replaced tier", () => {
    const base = makeBase({ p: { fast: [ref("anthropic", "sonnet")] } });
    const effective = applyProfile(base, "p");
    expect(findTierForModel(effective, "anthropic", "haiku")).toBeNull();
  });
});

// ─── Precedence (SPEC §9.6) ───────────────────────────────────────

describe("profile precedence over the router's own resolution", () => {
  it("/route-force (a manual model) outranks the profile", () => {
    const base = makeBase({ p: { fast: [ref("anthropic", "sonnet")] } });
    const effective = applyProfile(base, "p");
    const state = createRouterState();
    state.manualOverride = { active: true, provider: "anthropic", modelId: "haiku" };

    const decision = processRoute(
      { tier: "fast", source: "llm", confidence: 0.9 },
      state,
      effective,
      REGISTRY,
    );
    expect(decision.switchTo?.modelId).toBe("haiku");
    expect(decision.action).toBe("manual");
  });

  it("a forced tier resolves its model from the PROFILE's chain", () => {
    const base = makeBase({ p: { fast: [ref("anthropic", "sonnet")] } });
    const effective = applyProfile(base, "p");
    const state = createRouterState();
    state.manualOverride = { active: true, tier: "fast" };

    const decision = processRoute(
      { tier: "fast", source: "llm", confidence: 0.9 },
      state,
      effective,
      REGISTRY,
    );
    expect(decision.switchTo?.modelId).toBe("sonnet");
  });
});

// ─── The selection is session state ────────────────────────────────

describe("profile selection lives in RouterState", () => {
  it("starts with no profile selected", () => {
    expect(createRouterState().activeProfile).toBeNull();
  });

  it("is not stored anywhere but RouterState", () => {
    const state = createRouterState();
    state.activeProfile = "p";
    expect(state.activeProfile).toBe("p");
    // A fresh state must not inherit it — module-level state would.
    expect(createRouterState().activeProfile).toBeNull();
  });
});

// ─── No disk writes ────────────────────────────────────────────────

describe("selecting a profile writes nothing to disk", () => {
  const TMP = "/tmp/pi-shift-router-profiles-io";

  beforeEach(async () => {
    invalidateConfigCache();
    await rm(USER_CONFIG, { force: true });
    await rm(TMP, { force: true, recursive: true });
    await mkdir(join(TMP, ".pi"), { recursive: true });
  });

  afterEach(async () => {
    invalidateConfigCache();
    await rm(USER_CONFIG, { force: true });
    await rm(TMP, { force: true, recursive: true });
  });

  it("leaves the user config file byte-identical", async () => {
    await mkdir(join(USER_HOME, ".pi", "agent"), { recursive: true });
    const original = JSON.stringify(
      { enabled: true, profiles: { p: { fast: [{ provider: "anthropic", model: "sonnet", priority: 1 }] } } },
      null,
      2,
    );
    await writeFile(USER_CONFIG, original, "utf-8");

    const base = await loadConfig(TMP);
    const effective = applyProfile(base, "p");

    // The effective config carries the profile's chains — that is exactly
    // what must never reach the file.
    expect(effective.tiers.fast.models.map((m) => m.model)).toEqual(["sonnet"]);

    expect(readFileSync(USER_CONFIG, "utf-8")).toBe(original);
  });

  it("never creates a config file just because a profile was applied", async () => {
    const base = await loadConfig(TMP);
    applyProfile(base, "p");
    expect(existsSync(join(TMP, ".pi", "pi-shift-router.json"))).toBe(false);
  });

  it("saves the BASE config, not the effective one", async () => {
    const base = await loadConfig(TMP);
    base.tiers.fast.models = [ref("anthropic", "haiku")];
    base.profiles = { p: { fast: [ref("anthropic", "sonnet")] } };
    await saveConfig(base, TMP, "project");

    const written = JSON.parse(readFileSync(join(TMP, ".pi", "pi-shift-router.json"), "utf-8"));
    // The file keeps the base chain; the profile's chain lives under `profiles`.
    expect(written.tiers.fast.models.map((m: ModelRef) => m.model)).toEqual(["haiku"]);
    expect(written.profiles.p.fast.map((m: ModelRef) => m.model)).toEqual(["sonnet"]);
  });
});
