/**
 * pi-shift-router — Profile editing in the config wizard (SPEC §9.6)
 *
 * The wizard's "Profiles" surface: define, edit, and delete the named
 * tier-chain presets. These tests drive the real flow through a fake pi UI.
 *
 * The contract worth pinning:
 *   - a new profile is seeded from the configured chains (the workflow people
 *     actually want: "save what I have, then tweak it")
 *   - a profile's name must be non-empty and unique
 *   - the chains are edited with the SAME editor the tiers use
 *   - the wizard mutates the config it is given; saving is the caller's job
 */

import { describe, it, expect, vi } from "vitest";
import {
  editProfiles,
  profileCount,
  profileLabel,
  profileMap,
  validateProfileName,
  type ProfileEditorDeps,
} from "../src/profiles.js";
import { DEFAULT_CONFIG, type ModelRef, type ShiftRouterConfig } from "../src/types.js";

function ref(provider: string, model: string, priority = 1): ModelRef {
  return { provider, model, priority };
}

function makeConfig(): ShiftRouterConfig {
  const config: ShiftRouterConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.tiers.fast.models = [ref("anthropic", "haiku")];
  config.tiers.smart.models = [ref("anthropic", "opus")];
  return config;
}

/**
 * A fake pi UI that answers a scripted list of selections (and inputs) and
 * records what it was asked.
 */
function fakeUi(script: { selects?: string[]; inputs?: string[] }) {
  const selects = [...(script.selects ?? [])];
  const inputs = [...(script.inputs ?? [])];
  const asked: string[] = [];
  const notified: string[] = [];
  return {
    asked,
    notified,
    ctx: {
      mode: "text",
      ui: {
        select: async (title: string, options: string[]) => {
          asked.push(title);
          const next = selects.shift();
          if (next === undefined) return undefined;
          // The selection must exist in the offered options — a typo in the
          // script would otherwise silently test nothing.
          if (!options.includes(next)) {
            throw new Error(`scripted selection ${JSON.stringify(next)} not offered in ${JSON.stringify(options)}`);
          }
          return next;
        },
        input: async () => inputs.shift(),
        notify: (message: string) => notified.push(message),
        setStatus: () => {},
        custom: async () => null,
      },
    } as unknown as Parameters<typeof editProfiles>[1]["ctx"],
    selects,
    inputs,
  };
}

function depsFor(ui: ReturnType<typeof fakeUi>): ProfileEditorDeps {
  return {
    ctx: ui.ctx,
    allModels: () => [
      { provider: "anthropic", id: "haiku" } as never,
      { provider: "anthropic", id: "sonnet" } as never,
      { provider: "anthropic", id: "opus" } as never,
    ],
    isAvailable: () => true,
  };
}

// ─── Pure helpers ─────────────────────────────────────────────────

describe("profileMap", () => {
  it("creates the map on demand", () => {
    const config = makeConfig();
    expect(config.profiles).toBeUndefined();
    expect(profileMap(config)).toEqual({});
    expect(config.profiles).toEqual({});
  });

  it("returns the existing map untouched", () => {
    const config = makeConfig();
    config.profiles = { p: { fast: [] } };
    expect(profileMap(config).p).toEqual({ fast: [] });
  });
});

describe("the wizard does not litter the file with an empty map", () => {
  it("leaves `profiles` absent when the user only browses", async () => {
    const config = makeConfig();
    const ui = fakeUi({ selects: ["← Back to configuration"] });
    await editProfiles(config, depsFor(ui));
    expect("profiles" in config).toBe(false);
  });

  it("removes the map again when the last profile is deleted", async () => {
    const config = makeConfig();
    config.profiles = { only: {} };
    const ui = fakeUi({ selects: ["🗑 Delete a profile", "only"] });
    await editProfiles(config, depsFor(ui));
    expect("profiles" in config).toBe(false);
  });
});

describe("profileCount", () => {
  it("counts zero when no profiles are defined", () => {
    expect(profileCount(makeConfig())).toBe(0);
  });

  it("counts the defined profiles", () => {
    const config = makeConfig();
    config.profiles = { a: {}, b: {} };
    expect(profileCount(config)).toBe(2);
  });
});

describe("profileLabel", () => {
  it("shows how much of each chain the profile sets", () => {
    expect(profileLabel("p", { fast: [ref("a", "b")], smart: [ref("a", "c"), ref("a", "d")] }))
      .toContain("fast 1 · smart 2");
  });

  it("marks the active profile", () => {
    expect(profileLabel("p", {}, "p")).toContain("●");
    expect(profileLabel("p", {}, "other")).toContain("○");
  });
});

describe("validateProfileName", () => {
  it("rejects an empty name", () => {
    expect(validateProfileName("   ", [])).toBeTruthy();
  });

  it("rejects a duplicate name", () => {
    expect(validateProfileName("p", ["p"])).toContain("already exists");
  });

  it("accepts a fresh name and trims it", () => {
    expect(validateProfileName("  p  ", ["q"])).toBeNull();
  });
});

// ─── The editing flow ─────────────────────────────────────────────

describe("editProfiles", () => {
  it("creates a profile seeded from the configured chains", async () => {
    const config = makeConfig();
    // After "New profile" the flow lands in the new profile's editor (the
    // point is to set its chains right away), then back out twice.
    const ui = fakeUi({
      selects: ["➕ New profile", "← Back", "← Back to configuration"],
      inputs: ["review"],
    });
    await editProfiles(config, depsFor(ui));

    expect(config.profiles!.review!.fast!.map((m) => m.model)).toEqual(["haiku"]);
    expect(config.profiles!.review!.smart!.map((m) => m.model)).toEqual(["opus"]);
  });

  it("trims the profile name", async () => {
    const config = makeConfig();
    const ui = fakeUi({
      selects: ["➕ New profile", "← Back", "← Back to configuration"],
      inputs: ["  review  "],
    });
    await editProfiles(config, depsFor(ui));
    expect(Object.keys(config.profiles!)).toEqual(["review"]);
  });

  it("refuses a duplicate name and keeps the existing one", async () => {
    const config = makeConfig();
    config.profiles = { review: { fast: [ref("anthropic", "sonnet")] } };
    const ui = fakeUi({
      selects: ["➕ New profile", "← Back to configuration"],
      inputs: ["review"],
    });
    await editProfiles(config, depsFor(ui));

    expect(config.profiles!.review!.fast!.map((m) => m.model)).toEqual(["sonnet"]);
    expect(ui.notified.join("\n")).toContain("already exists");
  });

  it("refuses an empty name", async () => {
    const config = makeConfig();
    const ui = fakeUi({ selects: ["➕ New profile", "← Back to configuration"], inputs: ["   "] });
    await editProfiles(config, depsFor(ui));
    expect("profiles" in config).toBe(false);
    expect(ui.notified.join("\n")).toContain("cannot be empty");
  });

  it("deletes a profile", async () => {
    const config = makeConfig();
    config.profiles = { a: {}, b: {} };
    const ui = fakeUi({ selects: ["🗑 Delete a profile", "a"] });
    await editProfiles(config, depsFor(ui));
    expect(Object.keys(config.profiles!)).toEqual(["b"]);
  });

  it("edits a profile's chain through the chain editor", async () => {
    const config = makeConfig();
    config.profiles = { p: { fast: [ref("anthropic", "haiku")] } };
    // The chain editor is a TUI component; in text mode the flow uses the
    // single-model fallback instead. Drive that: pick a model.
    const ui = fakeUi({
      selects: ["○ p — fast 1 · smart 0", "🦾 Fast chain — 1 model(s)", "anthropic/sonnet", "← Back", "← Back to configuration"],
    });
    await editProfiles(config, depsFor(ui));

    expect(config.profiles!.p!.fast!.map((m) => m.model)).toEqual(["sonnet"]);
  });

  it("clears a chain through the text-mode fallback", async () => {
    const config = makeConfig();
    config.profiles = { p: { fast: [ref("anthropic", "haiku")] } };
    const ui = fakeUi({
      selects: ["○ p — fast 1 · smart 0", "🦾 Fast chain — 1 model(s)", "❌ Clear this chain", "← Back", "← Back to configuration"],
    });
    await editProfiles(config, depsFor(ui));
    expect(config.profiles!.p!.fast).toEqual([]);
  });

  it("leaves the config alone when the user backs out immediately", async () => {
    const config = makeConfig();
    const ui = fakeUi({ selects: ["← Back to configuration"] });
    await editProfiles(config, depsFor(ui));
    expect("profiles" in config).toBe(false);
  });

  it("stops on a dismissed dialog", async () => {
    const config = makeConfig();
    const ui = fakeUi({});
    await editProfiles(config, depsFor(ui));
    expect("profiles" in config).toBe(false);
  });
});
