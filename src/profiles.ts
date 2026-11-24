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
  /**
   * Activate a profile for this session — or clear the selection with null.
   *
   * The SELECTION is session state (SPEC §9.6), so the wizard cannot own it:
   * it asks the host to change it, exactly as `/router profile` does.
   * Optional — without it the wizard only manages the definitions.
   */
  setActiveProfile?: (name: string | null) => void | Promise<void>;
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
 * The Profiles list rows.
 *
 * The list is NAVIGATION, not a set of actions: each row opens that
 * profile's own menu, where its actions live. A row that duplicates an
 * action (a second "delete", a second "disable") is a trap — the user has
 * to guess which of two identical rows is the real one.
 *
 * The profile rows carry the project's exclusive-picker marker (● current /
 * ○ other) instead of an icon: every row here names a preset, and no preset
 * has an icon of its own. The action rows (➕, ✅) carry icons, so the two
 * kinds never read as the same thing.
 */
export function profileListOptions(config: ShiftRouterConfig, active: string | null): string[] {
  const options = ["➕ New profile"];
  for (const name of Object.keys(config.profiles ?? {})) {
    options.push(profileLabel(name, config.profiles![name]!, active));
  }
  options.push("✅ Back to configuration");
  return options;
}

/**
 * The per-profile action rows.
 *
 * The first row is a TOGGLE: activating a profile and disabling it are the
 * same decision seen from two sides, so they get one row that says what
 * picking it will do — never an "Activate" button on a profile that is
 * already active.
 */
export function profileActionOptions(profile: SessionProfile, isActive: boolean): string[] {
  return [
    isActive ? "⛔ Disable for this session" : "📋 Activate for this session",
    `🦾 Fast chain — ${profile.fast?.length ?? 0} model(s)`,
    `🧠 Smart chain — ${profile.smart?.length ?? 0} model(s)`,
    "🚫 Delete this profile",
    "✅ Back",
  ];
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
  // The selection can change while the wizard is open (the user may
  // activate or disable a profile here), so read it from the host each time
  // rather than from the value captured when the wizard opened.
  let active = activeProfile ?? null;

  for (;;) {
    const names = Object.keys(config.profiles ?? {});
    const options = profileListOptions(config, active);
    const actions: Array<{ kind: "new" } | { kind: "edit"; name: string } | { kind: "back" }> = [{ kind: "new" }];
    for (const name of names) actions.push({ kind: "edit", name });
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
      await editProfile(config, deps, name, () => active, (n) => {
        active = n;
      });
      continue;
    }

    if (action.kind === "edit") {
      await editProfile(config, deps, action.name, () => active, (n) => {
        active = n;
      });
    }
  }
}

/**
 * The per-profile menu: activate/disable it for this session, edit a chain,
 * or delete the profile.
 *
 * This is the ONE place a profile's actions live — the list above is pure
 * navigation, so there is never a second row that does the same thing.
 */
async function editProfile(
  config: ShiftRouterConfig,
  deps: ProfileEditorDeps,
  name: string,
  getActive: () => string | null,
  setActive: (name: string | null) => void,
): Promise<void> {
  const { ctx } = deps;
  const profiles = config.profiles ?? {};

  for (;;) {
    const profile = profiles[name];
    if (!profile) return;
    const isActive = getActive() === name;
    const options = profileActionOptions(profile, isActive);
    const choice = await ctx.ui.select(`Profile "${name}"`, options);
    if (!choice) return;
    const index = options.indexOf(choice);
    if (index < 0) return;

    if (index === 4) return;

    if (index === 3) {
      // Deleting a profile destroys work the user may have spent a while
      // assembling — and it is the only way to remove one, so it asks.
      const confirmed = await ctx.ui.confirm(
        `Delete the profile "${name}"?`,
        "This removes the preset. The tier chains it holds are lost.",
      );
      if (!confirmed) continue;
      removeProfile(config, name);
      // Deleting the ACTIVE profile leaves the session running chains that
      // no longer exist as a preset — say so instead of silently falling back.
      if (isActive) {
        ctx.ui.notify(
          `pi-shift-router: 🚫 Profile "${name}" deleted — it was active for this session, ` +
            `so the configured chains are back in force`,
          "warning",
        );
      } else {
        ctx.ui.notify(`pi-shift-router: 🚫 Profile "${name}" deleted`, "info");
      }
      return;
    }

    if (index === 0) {
      // One row, two meanings: it says what picking it will DO.
      if (isActive) {
        await deps.setActiveProfile?.(null);
        setActive(null);
        ctx.ui.notify("pi-shift-router: ⛔ Profile disabled — using the configured chains", "info");
        continue;
      }
      await deps.setActiveProfile?.(name);
      setActive(name);
      ctx.ui.notify(
        `pi-shift-router: 📋 Profile "${name}" active for this session — ` +
          `this wizard still edits the SAVED config`,
        "info",
      );
      continue;
    }

    const tier: Tier = index === 1 ? "fast" : "smart";
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

