/**
 * pi-shift-router — Per-session profile editing (SPEC §9.6)
 *
 * The configuration wizard's "Profiles" surface: define, edit, and delete the
 * named tier-chain presets. A profile is a *definition* — persistent, in the
 * config file; the *selection* is session state and lives elsewhere
 * (`RouterState.activeProfile`).
 *
 * This module owns the editing flow plus the pure helpers the rest of the
 * router reads. The shape of a profile itself lives in `types.ts`.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ModelRef, SessionProfile, ShiftRouterConfig, StoredModel, Tier } from "./types.js";
import { createChainEditor } from "./tui/fallback-chain-editor.js";

/**
 * What the editor needs from its host. Injected so this module stays
 * testable and free of pi-catalog plumbing.
 */
export interface ProfileEditorDeps {
  ctx: ExtensionCommandContext;
  /** Every model available for picking (already filtered to chat-capable). */
  allModels: () => StoredModel[];
  /** Whether a model is currently usable (present + authenticated). */
  isAvailable: (provider: string, model: string) => boolean;
}

/**
 * The profile map on a config, created on demand.
 *
 * `profiles` is deliberately absent from `DEFAULT_CONFIG` — no profiles
 * defined must stay distinguishable from an empty profile map, so the key
 * only appears once the user defines one. Callers that merely READ must use
 * `config.profiles ?? {}` instead, so that opening the wizard and saving
 * without defining anything does not litter the file with an empty map.
 *
 * NB: do not quote a phrase right after the word "from" in this comment —
 * the pack-isolation scanner reads that shape as an import specifier.
 */
export function profileMap(config: ShiftRouterConfig): Record<string, SessionProfile> {
  config.profiles ??= {};
  return config.profiles;
}

/** Remove a profile, and the map itself once it is empty. */
function removeProfile(config: ShiftRouterConfig, name: string): void {
  if (!config.profiles) return;
  delete config.profiles[name];
  if (Object.keys(config.profiles).length === 0) delete config.profiles;
}

/**
 * Menu label for one profile: its name and how much of each chain it sets.
 *
 * `●` marks the profile this session is running (SPEC §9.6's indicator
 * vocabulary — exclusive picker, not a status dot).
 */
export function profileLabel(
  name: string,
  profile: SessionProfile,
  active?: string | null,
): string {
  const fast = profile.fast?.length ?? 0;
  const smart = profile.smart?.length ?? 0;
  const mark = name === active ? "●" : "○";
  return `${mark} ${name} — fast ${fast} · smart ${smart}`;
}

/** A new profile's name must be non-empty and must not collide. */
export function validateProfileName(raw: string, existing: string[]): string | null {
  const name = raw.trim();
  if (!name) return "A profile name cannot be empty.";
  if (existing.includes(name)) return `A profile named "${name}" already exists.`;
  return null;
}

/** How many profiles a config defines. */
export function profileCount(config: ShiftRouterConfig): number {
  return Object.keys(config.profiles ?? {}).length;
}

/**
 * The wizard's Profiles surface. Mutates `config.profiles` in place — the
 * caller saves the config when the wizard exits.
 */
export async function editProfiles(
  config: ShiftRouterConfig,
  deps: ProfileEditorDeps,
  activeProfile?: string | null,
): Promise<void> {
  const { ctx } = deps;

  for (;;) {
    const names = Object.keys(config.profiles ?? {});
    const options: string[] = [];
    const actions: Array<{ kind: "new" } | { kind: "edit"; name: string } | { kind: "delete" } | { kind: "back" }> = [];

    options.push("➕ New profile");
    actions.push({ kind: "new" });
    for (const name of names) {
      options.push(profileLabel(name, config.profiles![name]!, activeProfile));
      actions.push({ kind: "edit", name });
    }
    options.push("🚫 Delete a profile");
    actions.push({ kind: "delete" });
    options.push("✅ Back to configuration");
    actions.push({ kind: "back" });

    const choice = await ctx.ui.select("pi-shift-router — Profiles", options);
    if (!choice) return;
    // Positional match: a profile name is user-controlled and may contain
    // anything, so the label cannot be matched by content.
    const index = options.indexOf(choice);
    if (index < 0) return;
    const action = actions[index]!;

    if (action.kind === "back") return;

    if (action.kind === "new") {
      const raw = await ctx.ui.input("Profile name", "e.g. review-heavy");
      if (raw === undefined) continue;
      const error = validateProfileName(raw, Object.keys(config.profiles ?? {}));
      if (error) {
        ctx.ui.notify(`pi-shift-router: ${error}`, "warning");
        continue;
      }
      const name = raw.trim();
      // Seed from the configured chains: "save what I have as a preset, then
      // tweak it" is the workflow people actually want.
      profileMap(config)[name] = {
        fast: config.tiers.fast.models.map((m) => ({ ...m })),
        smart: config.tiers.smart.models.map((m) => ({ ...m })),
      };
      ctx.ui.notify(
        `pi-shift-router: 📋 Profile "${name}" created from the current chains — set its chains now`,
        "info",
      );
      await editProfile(config, deps, name, activeProfile);
      continue;
    }

    if (action.kind === "delete") {
      await deleteProfile(config, deps);
      continue;
    }

    await editProfile(config, deps, action.name, activeProfile);
  }
}

/** The per-profile menu: edit a chain, or delete the profile. */
async function editProfile(
  config: ShiftRouterConfig,
  deps: ProfileEditorDeps,
  name: string,
  activeProfile?: string | null,
): Promise<void> {
  const { ctx } = deps;
  const profiles = config.profiles ?? {};

  for (;;) {
    const profile = profiles[name];
    if (!profile) return;
    const options = [
      `🦾 Fast chain — ${profile.fast?.length ?? 0} model(s)`,
      `🧠 Smart chain — ${profile.smart?.length ?? 0} model(s)`,
      "🚫 Delete this profile",
      "✅ Back",
    ];
    const choice = await ctx.ui.select(
      `Profile "${name}"${name === activeProfile ? " (active this session)" : ""}`,
      options,
    );
    if (!choice) return;
    const index = options.indexOf(choice);
    if (index < 0) return;

    if (index === 3) return;

    if (index === 2) {
      removeProfile(config, name);
      ctx.ui.notify(`pi-shift-router: 🚫 Profile "${name}" deleted`, "info");
      return;
    }

    const tier: Tier = index === 0 ? "fast" : "smart";
    const updated = await editChain(profile, tier, name, deps);
    if (updated) {
      if (tier === "fast") profile.fast = updated;
      else profile.smart = updated;
      ctx.ui.notify(
        `pi-shift-router: 📋 Profile "${name}" — ${tier} chain set to ${updated.length} model(s)`,
        "info",
      );
    }
  }
}

/**
 * Edit one tier chain of a profile. Reuses the tier chain editor, so the
 * interaction (add / remove / reorder, with unavailable models flagged) is
 * identical to editing the configured tiers.
 */
async function editChain(
  profile: SessionProfile,
  tier: Tier,
  profileName: string,
  deps: ProfileEditorDeps,
): Promise<ModelRef[] | null> {
  const { ctx } = deps;
  const current = (tier === "fast" ? profile.fast : profile.smart) ?? [];

  if (ctx.mode === "tui") {
    const unavailableKeys = new Set(
      current.filter((m) => !deps.isAvailable(m.provider, m.model)).map((m) => `${m.provider}/${m.model}`),
    );
    return await ctx.ui.custom<ModelRef[] | null>((_tui, theme, _keybindings, done) =>
      createChainEditor({
        items: current.map((m) => ({ ...m })),
        allModels: deps.allModels(),
        tier,
        tierLabel: `${profileName} — ${tier === "fast" ? "Fast" : "Smart"}`,
        theme,
        unavailableKeys,
        onDone: (items) => done(items),
        onCancel: () => done(null),
      }),
    );
  }

  // Non-TUI fallback: pick a single model (or clear the chain).
  const models = deps.allModels();
  if (models.length === 0) {
    ctx.ui.notify("No models available to pick", "warning");
    return null;
  }
  const labels = [
    "❌ Clear this chain",
    ...models.map((m) => `${m.provider}/${m.id}`),
  ];
  const pick = await ctx.ui.select(`${profileName} — ${tier} chain`, labels);
  if (!pick) return null;
  if (pick.includes("Clear")) return [];
  const index = labels.indexOf(pick);
  if (index < 1) return null;
  const model = models[index - 1]!;
  return [{ provider: model.provider, model: model.id, priority: 1 }];
}

/** Delete a profile, chosen from a list. */
async function deleteProfile(config: ShiftRouterConfig, deps: ProfileEditorDeps): Promise<void> {
  const { ctx } = deps;
  const names = Object.keys(config.profiles ?? {});
  if (names.length === 0) {
    ctx.ui.notify("pi-shift-router: no profiles to delete", "info");
    return;
  }
  const options = [...names, "✅ Back"];
  const pick = await ctx.ui.select("Delete which profile?", options);
  if (!pick) return;
  const index = options.indexOf(pick);
  if (index < 0 || index >= names.length) return;
  const name = names[index]!;
  removeProfile(config, name);
  ctx.ui.notify(`pi-shift-router: 🚫 Profile "${name}" deleted`, "info");
}
