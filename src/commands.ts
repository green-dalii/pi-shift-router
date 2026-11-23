/**
 * pi-shift-router — Slash commands
 *
 * /router          — Show status, enable/disable
 * /router status   — Detailed router state
 * /router config   — Interactive configuration wizard
 * /router eco|default|sport — Gear-shift economics presets (top-level so pi completes them)
 * /route-force     — Manual override for current turn
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
  ShiftRouterConfig,
  RouterState,
  Tier,
  ModelRef,
  EconomicMode,
  StoredModel,
  ModelsStore,
  AuthStore,
} from "./types.js";
import {
  TIERS,
  ECONOMIC_MODE_PRESETS,
  LEGACY_SAME_FAMILY_THRESHOLD_DEFAULT,
  ORCHESTRATION_LIMITS,
  type JudgeMode,
} from "./types.js";
import {
  isValidTier,
  tierEmoji,
  tierLabel,
  formatTierDisplay,
} from "./tier.js";
import {
  clearManualOverride,
  setManualOverrideModel,
  shareProviderFamily,
  effectiveTheta,
  legacyThetaOverride,
  sameFamilyThetaFactor,
} from "./router.js";
import { resetOrchestration } from "./orchestrate.js";
import { appendRouterLog } from "./log.js";
import { computeStats, judgeModelDisplay } from "./stats.js";
import { resolveJudgeEndpoints, normalizeJudgeMode, listProfiles } from "./config.js";
import { DECISION_API_TYPE, DECISION_MIN_JUDGE_TIMEOUT_MS } from "./judge.js";
import { listDecisionChoices, classifierTimeoutFloor } from "./decision.js";
import { StatusPanel, assembleStatusData, type StatusPanelInput } from "./tui/status-panel.js";
import { createChainEditor } from "./tui/fallback-chain-editor.js";
import { createModelPicker } from "./tui/model-picker.js";
import {
  listAvailableModels,
  isModelAvailable,
  refreshRegistry,
  refreshRegistryInBackground,
  CATALOG_REFRESH_TIMEOUT_MS,
  type ModelRegistryLike,
} from "./model-source.js";
import {
  getConfigPath,
  getConfigSource,
  userConfigPath,
  loadModelsStore,
  loadAuthStore,
  saveConfig,
  invalidateModelsStoreCache,
  invalidateAuthStoreCache,
} from "./config.js";

// ─── Helpers ──────────────────────────────────────────────────────

// ─── `/route-config` wizard ──────────────────────────────────────

type MenuChoice = "fast" | "smart" | "ux" | "cache" | "judge" | "orch" | "refresh" | "done" | "cancel";

/**
 * Status label for the economics mode. A set preset wins; otherwise the
 * effective preset is "default" only when reworkPenalty is untouched, else
 * "custom" (manual R).
 */
function economicModeLabel(config: ShiftRouterConfig): string {
  const mode = config.routing.economics?.mode;
  if (mode) return mode;
  const R = config.routing.economics?.reworkPenalty;
  return R === undefined || R === 3 ? "default" : "custom";
}

/**
 * A decision call measured 1.4–6.6 s against the live System One API, so the
 * LLM-judge default (5000 ms) would abort most of them and quietly hold every
 * turn. Raises the timeout to the protocol's floor — 15 s for System One, 8 s
 * for OpenAI Decisions — and reports the change so it is never a silent config
 * write. Returns `raised: false` when the user already set a value at or above
 * the floor (their choice stands).
 */
export function ensureDecisionJudgeTimeout(
  config: ShiftRouterConfig,
  floorMs: number = DECISION_MIN_JUDGE_TIMEOUT_MS,
): {
  from: number;
  to: number;
  raised: boolean;
} {
  const from = config.routing.judgeTimeout;
  if (from >= floorMs) return { from, to: from, raised: false };
  config.routing.judgeTimeout = floorMs;
  return { from, to: floorMs, raised: true };
}

/**
 * Models pi can actually *run a turn* with. Decision-protocol endpoints
 * (`typesafe-decisions`) are judge-only: pi has no streaming implementation for
 * them, so choosing one as a Fast/Smart tier model would fail at stream time on
 * every turn. Keeping them out of the tier pickers turns a broken session into
 * "not offered".
 */
export function chatCapableModels(models: StoredModel[]): StoredModel[] {
  return models.filter((m) => m.api !== DECISION_API_TYPE);
}

/**
 * Indicator vocabulary — one idiom per semantics (see SPEC §7.6):
 *   ● / ○  exclusive picker: exactly one row is the current choice (radio).
 *   ☑ / ☐  independent toggle: each row is on/off on its own (checkbox).
 * `●` on a toggle row would read as "the one selected", which is wrong for rows
 * that can all be on at once — and a screen of five filled circles loses the
 * "which is current?" signal. pi's own UI uses ● as a status indicator and its
 * official extension example uses ☑/☐ for item state, so we follow both.
 */
export function toggleRow(label: string, on: boolean): string {
  return `${on ? "☑" : "☐"} ${label}`;
}

/** Title suffix naming the toggle glyphs (a bare box is easy to misread). */
export const TOGGLE_LEGEND = "(☑ on · ☐ off)";

/**
 * Sub-menu rows for the Judge mode picker (SPEC §8.6). Pure + exported so the
 * labels (and therefore the width-sensitive emoji/spacing) stay under test.
 * Markers follow the project convention: ● current / ○ other.
 */
export function judgeModeOptions(current: JudgeMode, decisionCount: number): string[] {
  const mark = (on: boolean) => (on ? "● " : "○ ");
  return [
    `${mark(current === "fast-chain")}🦾 Reuse the Fast tier chain (default)`,
    `${mark(current === "custom")}🔬 Dedicated Judge LLM chain`,
    `${mark(current === "decision")}🧮 Decision model (Beta) — ${
      decisionCount === 0 ? "none available yet" : `${decisionCount} available`
    }`,
    "✅ Back",
  ];
}

/**
 * Mode for each `judgeModeOptions` row, in order. Keeps the menu's presentation
 * decoupled from positional index arithmetic in the handler.
 *
 * Order is deliberate: the legacy default (reuse the Fast chain) leads, the
 * dedicated LLM chain follows, and the decision model sits last as an explicitly
 * **Beta** option. Decision models are still less independently validated than
 * an LLM judge, so the mode is an opt-in extra — not a first-class judge that a
 * new user should land on by default (SPEC §8.6).
 */
export const JUDGE_MODE_ORDER: JudgeMode[] = ["fast-chain", "custom", "decision"];

/**
 * Actionable screen shown when no decision-capable endpoint is authenticated
 * (SPEC §8.6). A dismissible list, not a toast: the user needs the concrete
 * "api" value and the place to put it while they edit models.json.
 */
export function decisionSetupGuide(): string[] {
  return [
    "Why: no authenticated decision model is available yet",
    "1. Authenticate a provider that serves one: /login typesafe (Jev),",
    "   /login openai (gpt-6-luna), or an OpenRouter key you already have",
    "2. Then: /router config → 🧭 Judge → 🧮 Decision model (Beta)",
    "   The list comes from pi's own classifier catalog — no models.json edit",
    "Older pi? Hand-configured endpoints still work:",
    `   models.json → "api": "${DECISION_API_TYPE}" (deprecated, logs a notice)`,
    "Saved as-is; if it stops answering, routing falls back and tells you",
    "Meanwhile: the router keeps judging with your LLM judge — no stall",
    "Beta: less battle-tested than an LLM judge — the router falls back either way",
    "Prefer to stay on an LLM? Pick 🦾 Reuse the Fast chain or 🔬 Dedicated",
    "✅ Back",
  ];
}

/** One-line Judge-mode summary for the wizard menu (SPEC §8.6). Exported for tests. */
export function judgeSummary(config: ShiftRouterConfig, decisionCount?: number): string {
  const judge = config.routing.judge;
  // Normalized, not raw: a legacy models-without-mode config behaves as `custom`,
  // so the menu must say "dedicated" — the display must never disagree with what
  // the resolver will actually do.
  const mode: JudgeMode = normalizeJudgeMode(judge);
  if (mode === "fast-chain") return "reuse Fast tier chain (LLM)";
  if (mode === "decision" && decisionCount === 0) {
    // Chosen but unusable: say what is *actually* judging, not what was wished for.
    return "decision model unavailable — LLM judge active";
  }
  const models = judge?.models ?? [];
  if (models.length === 0) return `${mode} — no models (holds)`;
  const head = `${models[0]!.provider}/${models[0]!.model}`;
  const more = models.length > 1 ? ` +${models.length - 1}` : "";
  return mode === "decision" ? `decision model (Beta): ${head}${more}` : `dedicated: ${head}${more}`;
}

/** Same-family θ divisor for status display (mirrors router.sameFamilyThetaFactor). */
function sameFamilyFactorDisplay(config: ShiftRouterConfig): string {
  const ca = config.routing.cacheAware;
  if (typeof ca?.sameFamilyPenalty === "number" && ca.sameFamilyPenalty > 1) return String(ca.sameFamilyPenalty);
  // Legacy knob mirrors router.sameFamilyThetaFactor: the old default 0.9 is
  // dead (migrates to 1.5); only a differing value implies the strong 3.0.
  if (typeof ca?.sameFamilyThreshold === "number" && ca.sameFamilyThreshold !== LEGACY_SAME_FAMILY_THRESHOLD_DEFAULT) return "3";
  return "1.5";
}

/**
 * Persist config to whichever file is authoritative (project if it exists,
 * else user, else project as the default write target). All mutating
 * commands go through this — an in-memory mutation alone is lost on the
 * next `onConfigChanged()` reload.
 */
/**
 * Persist the config to the authoritative layer.
 *
 * The parameter is deliberately named `base`: it MUST be the on-disk config,
 * never the EFFECTIVE config (base merged with the selected profile).
 * `saveConfig` writes the whole snapshot, so an effective config would put
 * this session's profile chains into the user's global file (SPEC §9.6).
 */
async function persistConfig(base: ShiftRouterConfig, cwd: string): Promise<boolean> {
  const path = getConfigPath();
  const scope = path !== null && path === userConfigPath() ? "user" : "project";
  return saveConfig(base, cwd, scope);
}

/**
 * One-line description of WHICH config layer is authoritative for the
 * loaded config (v1.4.2): project file wins when present, else user file,
 * else compiled defaults. The user layer is merged underneath a project
 * file (project wins on conflict) — noted so users don't assume wholesale
 * replacement.
 */
function formatConfigSource(): string {
  const src = getConfigSource();
  if (src.source === "project") {
    return `Config: project (${src.path})${src.userLayerExists ? " — user layer merged underneath" : ""}`;
  }
  if (src.source === "user") {
    return `Config: user (${src.path})`;
  }
  return "Config: defaults (no config file yet — saving creates one)";
}

/**
 * The tier chain as a short "provider/model, provider/model" string — used
 * to tell the user what a profile selection actually changed (SPEC §9.6).
 */
function chainSummary(config: ShiftRouterConfig, tier: Tier): string {
  const models = config.tiers[tier]?.models ?? [];
  if (models.length === 0) return "(empty)";
  return models.map((m) => `${m.provider}/${m.model}`).join(", ");
}

/**
 * The "— active: …" part of the `/router profile` listing (SPEC §9.6).
 *
 * A profile that was removed from the config while it was selected is
 * STALE: the session runs the configured chains, so saying so is the honest
 * answer — otherwise the user sees "active: gone" next to chains that have
 * nothing to do with it.
 */
export function describeActiveProfile(active: string | null, defined: string[]): string {
  if (active === null) return "none";
  if (!defined.includes(active)) {
    return `${active} ⚠ no longer defined, using the configured chains`;
  }
  return active;
}

/**
 * Map a wizard option label to its menu action.
 *
 * Labels carry decorative emoji prefixes (🦾 🧠 🔒 …); matching on those is
 * collision-prone — both "🧠 Smart" and "🧠 Cache-aware" start with 🧠, so a
 * `startsWith` on the emoji silently routes Cache-aware into Smart. Instead we
 * match on stable English keywords that are unique across the fixed option
 * labels. Pure + unit-tested so a future label edit can't reintroduce a
 * routing bug. Also used for the provider/UX sub-menus where labels are fixed
 * strings too.
 */
export function matchMenuChoice(label: string): MenuChoice {
  if (label.includes("Model catalog")) return "refresh";
  if (label.includes("Cache-aware")) return "cache";
  if (label.includes("Orchestration")) return "orch";
  if (label.includes("Judge")) return "judge";
  if (label.includes("Fast")) return "fast";
  if (label.includes("Smart")) return "smart";
  if (label.includes("UX")) return "ux";
  if (label.includes("Save")) return "done";
  return "cancel";
}

/**
 * One line for the main menu: mode, budget, audit state.
 * Pure — the wizard re-renders it after every edit.
 */
export function orchestrationSummary(config: ShiftRouterConfig): string {
  const o = config.orchestration;
  return `${o.mode}, ${o.maxRounds} rounds, audit ${o.audit?.enabled !== false ? "on" : "off"}`;
}

/**
 * Numeric inputs come back as free text. Clamp instead of rejecting: a user
 * who types 99 wants "as many as allowed", not an error dialog. Junk keeps the
 * current value.
 */
export function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Map the "Save configuration to…" option label to its scope.
 * Same rationale as `matchMenuChoice`: emoji prefixes are decorative;
 * match on stable text keywords.
 */
export function matchSaveScope(label: string): "user" | "project" | null {
  if (label.includes("Project")) return "project";
  if (label.includes("User")) return "user";
  return null;
}

/**
 * Injectable edges of {@link prepareWizardCatalog} — tests pass fakes so the
 * disk read and the cache invalidation never touch the real agent dir.
 */
export interface WizardCatalogOverrides {
  invalidate?: () => void;
  readStores?: () => Promise<{ store: ModelsStore; auth: AuthStore }>;
  refreshTimeoutMs?: number;
}

export interface WizardCatalog {
  store: ModelsStore;
  auth: AuthStore;
  registry?: ModelRegistryLike;
  /** Settles when pi's registry refresh finishes, aborts or fails. Never rejects. */
  refreshing: Promise<void>;
}

/**
 * The catalog `/router config` shows, built without waiting on the network.
 *
 * Re-reading `models.json` + `auth.json` costs ~1.4 ms and is what makes
 * `/login` and `/logout` visible to the wizard. pi's `registry.refresh()` is a
 * different animal: it runs a model-list fetch plus an auth check for every
 * provider (measured 0.19–4.3 s each, run concurrently, and *not* skipped by
 * `allowNetwork: false`). Awaiting it before the first UI froze the wizard for
 * seconds, so it runs in the background now — the pickers read the snapshot
 * again each time they open, by which point the refresh has usually landed.
 */
export async function prepareWizardCatalog(
  registry: ModelRegistryLike | undefined,
  overrides: WizardCatalogOverrides = {},
): Promise<WizardCatalog> {
  const invalidate =
    overrides.invalidate ??
    (() => {
      invalidateModelsStoreCache();
      invalidateAuthStoreCache();
    });
  const readStores =
    overrides.readStores ??
    (async () => ({ store: await loadModelsStore(), auth: await loadAuthStore() }));

  invalidate();
  const { store, auth } = await readStores();
  return {
    store,
    auth,
    registry,
    refreshing: refreshRegistryInBackground(
      registry,
      overrides.refreshTimeoutMs ?? CATALOG_REFRESH_TIMEOUT_MS,
    ),
  };
}

export function decisionModelsFor(registry: ModelRegistryLike | undefined, models: StoredModel[]): StoredModel[] {
  return listDecisionChoices(registry, models);
}

export async function routeConfigWizard(
  config: ShiftRouterConfig,
  cwd: string,
  ctx: ExtensionCommandContext,
  catalogOverrides?: WizardCatalogOverrides,
): Promise<boolean> {
  const registry = (ctx as any).modelRegistry as ModelRegistryLike | undefined;
  const catalogStarted = Date.now();
  const catalog = await prepareWizardCatalog(registry, catalogOverrides);
  const { store, auth } = catalog;
  appendRouterLog(
    `[ShiftRouter] wizard catalog ready in ${Date.now() - catalogStarted} ms ` +
      `(pi's registry availability refresh continues in the background)`,
  );
  // Read the catalog at each point of use rather than once here: pickers open
  // seconds after the menu, and by then the background refresh usually has a
  // fresher snapshot (pi's own `/model` reads the snapshot too).
  const modelSource = () => ({ registry, store, auth });
  const modelList = (): StoredModel[] => listAvailableModels(modelSource());
  let allModels = modelList();
  if (allModels.length === 0) {
    // The one case where waiting is right: with nothing to show, the
    // background refresh is the only thing that can produce a catalog, and
    // exiting with "No models found" would be wrong while it is still running.
    // Bounded by the refresh timeout, and it never rejects.
    await catalog.refreshing;
    allModels = modelList();
  }
  if (allModels.length === 0 && Object.keys(store).length > 0) {
    ctx.ui.notify("No authenticated providers — run /login for a provider before configuring tiers", "warning");
  }

  if (allModels.length === 0) {
    ctx.ui.notify("No models found in models-store.json", "error");
    return false;
  }

  type MenuChoice = "fast" | "smart" | "ux" | "cache" | "judge" | "orch" | "refresh" | "done" | "cancel";
  async function saveDestination(): Promise<"user" | "project" | null> {
    const choice = await ctx.ui.select("Save configuration to…", [
      "📁 Project — <cwd>/.pi/pi-shift-router.json (shareable with team)",
      "👤 User — ~/.pi/agent/pi-shift-router.json (personal)",
      "🚫 Cancel save",
    ]);
    if (!choice) return null;
    return matchSaveScope(choice);
  }

  async function menu(): Promise<MenuChoice> {
    // The counts reflect the snapshot as of this render — the background
    // refresh updates it, so reopening the menu shows what landed.
    const models = modelList();
    const choice = await ctx.ui.select("pi-shift-router — Configuration", [
      `🦾 Fast — ${config.tiers.fast.models.length} model(s)  (engineer: execution, daily coding)`,
      `🧠 Smart — ${config.tiers.smart.models.length} model(s)  (CTO: direction, review, hard problems)`,
      `🧭 Judge — ${judgeSummary(config, decisionModelsFor(registry, models).length)}`,
      `🪄 Orchestration — ${orchestrationSummary(config)}`,
      "🎨 UX settings",
      "🔒 Cache-aware routing",
      `🔄 Model catalog — refresh now (${models.length} available)`,
      "💾 Save & exit",
      "🚫 Discard & exit",
    ]);

    if (!choice) return "cancel";
    return matchMenuChoice(choice);
  }

  /**
   * Manual escape hatch: wait for pi's availability pass on purpose — and say
   * so while waiting. The wizard deliberately does not do this on open.
   */
  async function refreshCatalog(): Promise<void> {
    const started = Date.now();
    const statusKey = "shift-router-catalog";
    // A session swap (or reload) mid-refresh makes pi's ctx stale, and its UI
    // calls then throw. Cleanup must not become the command's error.
    const clearStatus = () => {
      try {
        ctx.ui.setStatus(statusKey, undefined);
      } catch {
        /* stale ctx after a session swap — nothing to clean up */
      }
    };
    ctx.ui.setStatus(statusKey, "⏳ refreshing model catalog…");
    try {
      await refreshRegistry(registry, {
        signal: AbortSignal.timeout(CATALOG_REFRESH_TIMEOUT_MS),
      });
    } finally {
      clearStatus();
    }
    const count = modelList().length;
    appendRouterLog(
      `[ShiftRouter] wizard catalog refreshed in ${Date.now() - started} ms (${count} models)`,
    );
    try {
      ctx.ui.notify(`pi-shift-router: 🔄 ${count} models available`, "info");
    } catch {
      /* same stale-ctx case as above */
    }
  }

  async function editTier(tier: Tier): Promise<void> {
    const cfg = config.tiers[tier];

    // TUI mode: use the chain editor with add/remove/reorder
    if (ctx.mode === "tui") {
      const unavailableKeys = new Set(
        cfg.models
          .filter((m) => !isModelAvailable(modelSource(), m.provider, m.model))
          .map((m) => `${m.provider}/${m.model}`),
      );
      const updated = await ctx.ui.custom<ModelRef[] | null>(
        (_tui, theme, _keybindings, done) => {
          return createChainEditor({
            items: cfg.models,
            allModels: chatCapableModels(modelList()),
            tier,
            tierLabel: cfg.label,
            theme,
            unavailableKeys,
            onDone: (items) => done(items),
            onCancel: () => done(null),
          });
        },
      );
      if (updated) cfg.models = updated;
      return;
    }

    // Non-TUI fallback: single-model pick via provider grouping
    const selectedKey = cfg.models[0]
      ? `${cfg.models[0].provider}/${cfg.models[0].model}`
      : null;

    const availModels = chatCapableModels(modelList()).filter((m) => m.cost?.input != null);

    // Group models by provider
    const byProvider = new Map<string, typeof availModels>();
    for (const m of availModels) {
      const group = byProvider.get(m.provider) ?? [];
      group.push(m);
      byProvider.set(m.provider, group);
    }

    // Step 1: pick provider (or search)
    for (;;) {
      const providers = [...byProvider.keys()].sort();
      const provOpts: string[] = [];
      if (selectedKey) provOpts.push("❌ Clear selection");
      provOpts.push(
        ...providers.map((p) => {
          const count = byProvider.get(p)?.length ?? 0;
          const mark = selectedKey?.startsWith(p + "/") ? "●" : "○";
          return `${mark} ${p}  (${count})`;
        }),
      );
      provOpts.push("🔍 Search all models", "✅ Done");

      const provPick = await ctx.ui.select(
        `Select ${tierEmoji(tier)} ${cfg.label} — pick provider first`,
        provOpts,
      );
      if (!provPick || provPick.includes("Done")) return;
      if (provPick.includes("Clear selection")) { cfg.models = []; return; }

      // Search
      if (provPick.includes("Search all models")) {
        const query = await ctx.ui.input("Search model by name or provider…");
        if (!query?.trim()) continue;
        const q = query.trim().toLowerCase();
        const matches = availModels.filter((m) =>
          m.id.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q),
        );
        if (matches.length === 0) {
          ctx.ui.notify("No models match your search", "error");
          continue;
        }
        const picked = await pickModel(matches, `Search results for "${query.trim()}"`, selectedKey, tier);
        if (picked) { cfg.models = [picked]; return; }
        continue;
      }

      // Extract provider from selection text
      const provName = providers.find((p) => provPick.includes(` ${p} `) || provPick.endsWith(` ${p}`));
      if (!provName) continue;

      // Step 2: pick model from this provider
      const provModels = byProvider.get(provName)!;
      const picked = await pickModel(provModels, `Select model from ${provName}`, selectedKey, tier);
      if (picked) { cfg.models = [picked]; return; }
    }
  }

  /**
   * Model picker: TUI component with real-time filter + sliding viewport.
   * Falls back to ctx.ui.select() in non-TUI modes.
   */
  async function pickModel(
    models: typeof allModels,
    header: string,
    selectedKey: string | null,
    tier: Tier,
  ): Promise<{ provider: string; model: string; priority: number } | null> {
    // TUI mode: use the new picker with input + filter + sliding list
    if (ctx.mode === "tui") {
      return await ctx.ui.custom<{ provider: string; model: string; priority: number } | null>(
        (_tui, theme, _keybindings, done) => {
          return createModelPicker({
            theme,
            items: models.map((m) => ({
              provider: m.provider,
              id: m.id,
              cost: { input: m.cost?.input ?? 0 },
            })),
            selectedKey,
            tierLabel: `${tier} (${header})`,
            onSelect: (r) => done({ provider: r.provider, model: r.model, priority: 1 }),
            onCancel: () => done(null),
          });
        },
      );
    }

    // Non-TUI fallback: simple select with full key in label
    for (;;) {
      const labels = models.map((m) => {
        const key = `${m.provider}/${m.id}`;
        const isSelected = key === selectedKey;
        const prefix = isSelected ? "●" : "○";
        return `${prefix} ${key.padEnd(35)} $${m.cost!.input.toFixed(3)}/M`;
      });

      labels.push("✅ Back");
      const pick = await ctx.ui.select(header, labels);
      // Positional match — `includes(key)` would mis-hit when one model id is
      // a prefix of another (kimi/k2 vs kimi/k2-turbo).
      const idx = pick ? labels.indexOf(pick) : -1;
      if (idx < 0 || idx >= models.length) return null;
      return { provider: models[idx].provider, model: models[idx].id, priority: 1 };
    }
  }

  async function editUX(): Promise<void> {
    const ux = config.ux;
    const lines = [
      toggleRow("Quiet mode — no inline toast notifications", ux.quietMode),
      toggleRow("Status bar — show current tier/model in footer", ux.statusBar),
      toggleRow("Inline toast — notify on tier change", ux.inlineToast),
      toggleRow(
        "Verbose log — write decisions to ~/.pi/agent/logs/shift-router.log (debug)",
        ux.routerLogVerbose,
      ),
      "✅ Done",
    ];

    const pick = await ctx.ui.select(`🎨 UX Settings ${TOGGLE_LEGEND}`, lines);
    if (!pick) return;
    // Positional match — labels are display text, not identifiers.
    const idx = lines.indexOf(pick);
    if (idx === 0) ux.quietMode = !ux.quietMode;
    else if (idx === 1) ux.statusBar = !ux.statusBar;
    else if (idx === 2) ux.inlineToast = !ux.inlineToast;
    else if (idx === 3) ux.routerLogVerbose = !ux.routerLogVerbose;
  }

  async function editCacheAware(): Promise<void> {
    const cache = config.routing.cacheAware ?? {
      enabled: true,
      sameFamilyPenalty: 1.5,
      idleBoundaryMs: 5 * 60_000,
    };
    const lines = [
      toggleRow(
        "Cache-aware routing — avoid paying full price for repeated context: when Fast and Smart use the same provider, the router keeps the warm prompt cache by switching models less often (you can toggle this on/off here)",
        cache.enabled,
      ),
      "✅ Done",
    ];

    const pick = await ctx.ui.select(`🔒 Cache-aware Routing ${TOGGLE_LEGEND}`, lines);
    if (!pick) return;
    if (lines.indexOf(pick) === 0) {
      config.routing.cacheAware = { ...cache, enabled: !cache.enabled };
    }
  }

  async function editOrchestration(): Promise<void> {
    const o = config.orchestration;
    const limits = ORCHESTRATION_LIMITS;
    for (;;) {
      const lines = [
        toggleRow("Mode — auto: complex turns run as a Smart CTO loop", o.mode === "auto"),
        `🔁 Max rounds — ${o.maxRounds}  (worker → review rounds per task)`,
        `🛟 Escalation threshold — ${o.escalationThreshold}  (take over after N consecutive worker failures)`,
        toggleRow("Acceptance audit — review the CTO's claims post-turn", o.audit?.enabled !== false),
        "✅ Done",
      ];
      const pick = await ctx.ui.select(`🪄 Orchestration Settings ${TOGGLE_LEGEND}`, lines);
      if (!pick) return;
      const idx = lines.indexOf(pick);
      if (idx === 0) {
        o.mode = o.mode === "auto" ? "off" : "auto";
      } else if (idx === 1) {
        const raw = await ctx.ui.input(
          `Max rounds (${limits.maxRounds.min}–${limits.maxRounds.max}) — one round = one worker → review cycle`,
          String(o.maxRounds),
        );
        if (raw !== undefined) {
          o.maxRounds = clampInt(raw, limits.maxRounds.min, limits.maxRounds.max, limits.maxRounds.fallback);
        }
      } else if (idx === 2) {
        const raw = await ctx.ui.input(
          `Escalation threshold (${limits.escalationThreshold.min}–${limits.escalationThreshold.max}) — consecutive worker failures before the CTO takes over`,
          String(o.escalationThreshold),
        );
        if (raw !== undefined) {
          o.escalationThreshold = clampInt(
            raw,
            limits.escalationThreshold.min,
            limits.escalationThreshold.max,
            limits.escalationThreshold.fallback,
          );
        }
      } else if (idx === 3) {
        o.audit = { timeoutMs: o.audit?.timeoutMs ?? 5000, enabled: o.audit?.enabled === false };
      } else if (idx === 4) {
        return;
      }
    }
  }

  /** Shared: open the chain editor (or a flat picker in non-TUI modes). */
  async function openChainEditor(
    items: ModelRef[],
    models: StoredModel[],
    label: string,
  ): Promise<ModelRef[] | null> {
    if (ctx.mode !== "tui") {
      const labels = models.map((m) => `${m.provider}/${m.id}`);
      const pick = await ctx.ui.select(`Select ${label} model`, [...labels, "✅ Back"]);
      const idx = pick ? labels.indexOf(pick) : -1;
      if (idx < 0) return null;
      return [{ provider: models[idx]!.provider, model: models[idx]!.id, priority: 1 }];
    }
    const unavailableKeys = new Set(
      items.filter((m) => !isModelAvailable(modelSource(), m.provider, m.model)).map((m) => `${m.provider}/${m.model}`),
    );
    return await ctx.ui.custom<ModelRef[] | null>((_tui, theme, _keybindings, done) =>
      createChainEditor({
        items,
        allModels: models,
        tier: "fast", // unused by the editor (display only via tierLabel)
        tierLabel: label,
        theme,
        unavailableKeys,
        onDone: (next) => done(next),
        onCancel: () => done(null),
      }),
    );
  }

  /**
   * Judge mode editor (SPEC §8.6). Three modes: reuse the Fast chain (default),
   * a dedicated Judge LLM chain, or a decision model — which on pi ≥ 1.4.0 means
   * a model from pi's own classifier catalog (TypeSafe Jev, OpenAI Decisions,
   * Cloudflare Clef, …), judged through `registry.classify()`. Legacy
   * `models.json` decision endpoints are still listed, marked deprecated.
   * Listing is a synchronous catalog read: no auth probe, no network (issue #52).
   */
  async function editJudge(): Promise<void> {
    const judge = config.routing.judge ?? { mode: "fast-chain" as JudgeMode };
    const current: JudgeMode = normalizeJudgeMode(judge);
    const decisionModels = decisionModelsFor(registry, modelList());
    const opts = judgeModeOptions(current, decisionModels.length);
    const picked = await ctx.ui.select("🧭 Judge — the model that picks your model", opts);
    const idx = picked ? opts.indexOf(picked) : -1;
    const mode = idx >= 0 && idx < JUDGE_MODE_ORDER.length ? JUDGE_MODE_ORDER[idx] : null;

    if (mode === "fast-chain") {
      config.routing.judge = { ...judge, mode: "fast-chain" };
      ctx.ui.notify("pi-shift-router: 🧭 Judge = 🦾 reuse the Fast tier chain", "info");
      return;
    }
    if (mode === "custom") {
      const items = await openChainEditor(judge.models ?? [], modelList(), "Dedicated Judge");
      if (!items || items.length === 0) return;
      config.routing.judge = { mode: "custom", models: items };
      ctx.ui.notify(
        `pi-shift-router: 🧭 Judge = 🔬 dedicated LLM chain saved (${items.length} model(s))` +
          (judge.mode === "decision" ? " — replaces Jev" : ""),
        "info",
      );
      return;
    }
    if (mode !== "decision") return;

    if (decisionModels.length === 0) {
      // Toast notifications vanish before the user can act on them; the setup
      // steps live on a dismissible screen instead (and nothing is written).
      await ctx.ui.select("🧮 Decision model — setup needed", decisionSetupGuide());
      ctx.ui.notify("pi-shift-router: 🧭 Judge unchanged — no decision endpoint configured", "warning");
      return;
    }
    const items = await openChainEditor(judge.models ?? [], decisionModels, "Decision judge");
    if (!items || items.length === 0) return;

    // Local static validation only — no network call. A save-time probe would
    // prove the endpoint works *this second* (Jev is in beta: capacity, revoked
    // keys and regional flakiness all move), while costing a blocking round trip
    // on the config UI. The runtime ladder below covers the real cases and says
    // so out loud, so the wizard just checks what it can check offline.
    const candidate = {
      ...config,
      routing: { ...config.routing, judge: { mode: "decision" as JudgeMode, models: items } },
    };
    const endpoints = await resolveJudgeEndpoints(candidate, store, auth, process.env, registry);
    const first = endpoints[0];
    const usable = first && (!!first.classifier || first.apiType === DECISION_API_TYPE);
    if (!usable) {
      ctx.ui.notify(
        "pi-shift-router: could not resolve the selected decision model (missing auth or baseUrl). 🧭 Judge mode unchanged.",
        "error",
      );
      return;
    }
    config.routing.judge = { mode: "decision", models: items };
    const timeout = ensureDecisionJudgeTimeout(
      config,
      first.classifier
        ? classifierTimeoutFloor(first.classifier.api ?? first.apiType)
        : DECISION_MIN_JUDGE_TIMEOUT_MS,
    );
    ctx.ui.notify(
      `pi-shift-router: 🧭 Judge = 🧮 decision model ${first.provider}/${first.modelId} ` +
        (first.classifier ? `(pi classifier: ${first.apiType})` : "(legacy endpoint — deprecated)") +
        (timeout.raised
          ? ` — judgeTimeout ${timeout.from} → ${timeout.to} ms (decision calls need the protocol floor)`
          : "") +
        " · falls back to your LLM judge if it becomes unreachable",
      "info",
    );
  }

  // Main loop
  let saving = false;
  for (;;) {
    const choice = await menu();
    if (choice === "cancel") return false;
    if (choice === "done") { saving = true; break; }
    if (choice === "fast" || choice === "smart") {
      await editTier(choice);
    } else if (choice === "ux") {
      await editUX();
    } else if (choice === "cache") {
      await editCacheAware();
    } else if (choice === "judge") {
      await editJudge();
    } else if (choice === "orch") {
      await editOrchestration();
    } else if (choice === "refresh") {
      await refreshCatalog();
    }
  }

  if (!saving) return false;

  const scope = await saveDestination();
  if (!scope) return false;

  const saved = await saveConfig(config, cwd, scope);
  if (saved) {
    ctx.ui.notify(`pi-shift-router: 💾 Configuration saved to ${getConfigPath() ?? scope + " config"}`, "info");
  } else {
    ctx.ui.notify("pi-shift-router: ⚠ Failed to save configuration", "error");
  }
  return saved;
}

// ─── Command registration ────────────────────────────────────────

export function registerCommands(
  pi: ExtensionAPI,
  getConfig: () => ShiftRouterConfig,
  getBaseConfig: () => ShiftRouterConfig,
  getState: () => RouterState,
  onConfigChanged: () => void | Promise<void>,
  onManualOverrideTier: (tier: Tier) => void,
  updateStatus: (ui: any) => void,
  onProfileChange: (name: string | null, ui: any) => void | Promise<void>,
): void {
  // ── /router ──────────────────────────────────────────────────
  pi.registerCommand("router", {
    description: "pi-shift-router: show status, enable/disable",
    getArgumentCompletions: (prefix: string) => {
      const cmds = ["on", "off", "status", "quiet", "verbose", "config", "orchestrate", "eco", "default", "sport", "profile"].filter((c) => c.startsWith(prefix));
      // "/router profile <prefix>" → complete the profile names.
      const parts = prefix.trimStart().split(/\s+/);
      if (parts.length >= 2 && parts[0]!.toLowerCase() === "profile") {
        const names = listProfiles(getBaseConfig()).filter((n) => n.startsWith(parts[1]!));
        return names.length > 0 ? names.map((n) => ({ value: `profile ${n}`, label: n })) : null;
      }
      return cmds.length > 0 ? cmds.map((c) => ({ value: c, label: c })) : null;
    },
    handler: async (args, ctx) => {
      // `config` is the EFFECTIVE config (what the router is actually
      // running — base merged with the selected profile); `base` is the
      // on-disk config. Anything that MUTATES or SAVES must use `base`:
      // saveConfig writes the whole snapshot, so an effective config would
      // push this session's profile chains into the user's global file.
      const config = getConfig();
      const base = getBaseConfig();
      const state = getState();
      const rawArgs = args.trim();
      const arg = rawArgs.toLowerCase();

      // ── /router profile [name|off] ───────────────────────────
      // The selection is SESSION state (SPEC §9.6) — it is never written
      // to disk. The profile DEFINITIONS live in the base config.
      if (arg === "profile" || arg.startsWith("profile ")) {
        const rest = rawArgs.slice("profile".length).trim();
        const profiles = listProfiles(base);
        if (!rest) {
          const items = profiles.length
            ? profiles.map((n) => `${n === state.activeProfile ? "●" : "○"} ${n}`).join("   ")
            : "none defined — add a \"profiles\" map to your pi-shift-router.json";
          ctx.ui.notify(
            `pi-shift-router: 🗂 Profiles: ${items}   — active: ${describeActiveProfile(state.activeProfile, profiles)}`,
            "info",
          );
          return;
        }
        if (profiles.includes(rest)) {
          await onProfileChange(rest, ctx.ui);
          ctx.ui.notify(
            `pi-shift-router: 🗂 Profile "${rest}" active for this session — ` +
              // Re-read the config: the selection produced a NEW effective
              // config object, so the one captured at handler entry is stale.
              `Fast: ${chainSummary(getConfig(), "fast")} · Smart: ${chainSummary(getConfig(), "smart")}`,
            "info",
          );
          return;
        }
        if (rest.toLowerCase() === "off") {
          await onProfileChange(null, ctx.ui);
          ctx.ui.notify("pi-shift-router: 🗂 Profile cleared — using the configured tier chains", "info");
          return;
        }
        ctx.ui.notify(
          `pi-shift-router: ⚠ No profile named "${rest}" — nothing changed` +
            (profiles.length ? ` (defined: ${profiles.join(", ")})` : " (no profiles are defined)"),
          "warning",
        );
        return;
      }

      if (arg === "orchestrate") {
        ctx.ui.notify(
          `pi-shift-router: 🪄 Usage: /router orchestrate auto|off — auto (default): complex tasks → Smart CTO delegates to Fast subagents (requires pi-subagents; without it, plain smart run); off: plain two-tier routing`,
          "info",
        );
        return;
      }
      if (arg === "orchestrate auto") {
        base.orchestration.mode = "auto";
        await persistConfig(base, ctx.cwd);
        await onConfigChanged();
        updateStatus(ctx.ui);
        ctx.ui.notify("pi-shift-router: 🪄 Orchestration AUTO — complex tasks will run as Smart-orchestrated loops, simple tasks stay on the plain router", "info");
        return;
      }
      if (arg === "orchestrate off") {
        base.orchestration.mode = "off";
        resetOrchestration(state);
        updateStatus(ctx.ui);
        await persistConfig(base, ctx.cwd);
        await onConfigChanged();
        ctx.ui.notify("pi-shift-router: 🪄 Orchestration OFF — back to plain tier routing", "info");
        return;
      }
      if (arg === "orchestrate on") {
        // Legacy alias: "on" meant the same judge-driven behavior; map to auto.
        base.orchestration.mode = "auto";
        await persistConfig(base, ctx.cwd);
        await onConfigChanged();
        ctx.ui.notify("pi-shift-router: 🪄 Orchestration AUTO (legacy `on` mapped to auto) — complex tasks orchestrate, simple tasks stay on the plain router", "info");
        return;
      }

      if (arg === "on") {
        base.enabled = true;
        await persistConfig(base, ctx.cwd);
        await onConfigChanged();
        updateStatus(ctx.ui);
        ctx.ui.notify("pi-shift-router: ✅ Enabled", "info");
        return;
      }
      if (arg === "off") {
        base.enabled = false;
        await persistConfig(base, ctx.cwd);
        await onConfigChanged();
        updateStatus(ctx.ui);
        ctx.ui.notify("pi-shift-router: ⛔ Disabled", "info");
        return;
      }
      if (arg === "config") {
        // The wizard edits the SAVED config — it must never receive the
        // effective config, or a profile's chains would be written to disk.
        if (state.activeProfile) {
          ctx.ui.notify(
            `pi-shift-router: 🗂 Profile "${state.activeProfile}" is active — this wizard edits the SAVED config; ` +
              `the session keeps running the profile's chains until "/router profile off"`,
            "warning",
          );
        }
        await routeConfigWizard(base, ctx.cwd, ctx);
        await onConfigChanged();
        updateStatus(ctx.ui);
        // Show which layer is now authoritative — a wizard save may have
        // created the project file (default write target) just now.
        ctx.ui.notify(`pi-shift-router: ${formatConfigSource()}`, "info");
        return;
      }
      if (arg === "quiet") {
        base.ux.quietMode = !base.ux.quietMode;
        await persistConfig(base, ctx.cwd);
        await onConfigChanged();
        ctx.ui.notify(`pi-shift-router: ${base.ux.quietMode ? "🔇 Quiet" : "🔊 Notifications"}`, "info");
        return;
      }
      if (arg === "verbose" || arg === "log") {
        base.ux.routerLogVerbose = !base.ux.routerLogVerbose;
        await persistConfig(base, ctx.cwd);
        await onConfigChanged();
        ctx.ui.notify(
          `pi-shift-router: ${base.ux.routerLogVerbose ? "📝 Verbose logging ON → ~/.pi/agent/logs/shift-router.log" : "📝 Verbose logging OFF"}`,
          "info",
        );
        return;
      }
      // Gear presets are TOP-LEVEL commands so pi can tab-complete them:
      // /router eco | default | sport. The old `/router mode <gear>` form was
      // removed — the gear sat in the second arg slot, which pi never
      // completes. The config field (routing.economics.mode) is unchanged.
      const gearMatch = /^(eco|default|sport)$/.exec(arg);
      if (gearMatch) {
        const mode = gearMatch[1] as EconomicMode;
        const R = ECONOMIC_MODE_PRESETS[mode];
        base.routing.economics = { ...(base.routing.economics ?? { reworkPenalty: 3, downgradeMemory: 2 }), mode };
        await persistConfig(base, ctx.cwd);
        await onConfigChanged();
        updateStatus(ctx.ui);
        const theta = (1 / R).toFixed(2);
        // The EFFECTIVE config here: theta is derived from the tier chains
        // the router will actually use (a profile may have replaced them),
        // and routing is shared by reference with the base config.
        const effective = effectiveTheta(config);
        const effNote =
          Math.abs(effective - 1 / R) > 1e-9 && shareProviderFamily(config)
            ? ` → θ_eff ${effective.toFixed(2)} (same-family ÷${sameFamilyFactorDisplay(config)})`
            : "";
        const blurb =
          mode === "eco"
            ? "cheaper: only clearly-needed turns run smart"
            : mode === "sport"
              ? "eager: any real chance of needing Smart escalates"
              : "default bar";
        const legacyBar = legacyThetaOverride(config);
        ctx.ui.notify(
          `pi-shift-router: 🚗 Mode ${mode} — R=${R} (θ=${theta}${effNote}) — ${blurb}` +
            (legacyBar !== undefined ? ` ⚠ legacy window.threshold=${legacyBar} (non-default value) still overrides θ — remove it from config to let the mode take effect` : ""),
          "info",
        );
        return;
      }
      if (arg === "status") {
        const now = Date.now();
        const store = await loadModelsStore();

        // Cost telemetry (money section) — a null baseline (no pricing) is fine.
        const snapshot = computeStats(
          state,
          config,
          now,
          store,
          (ctx as any).modelRegistry as ModelRegistryLike | undefined,
        );
        const money = snapshot.cost.baselineModel
          ? {
              spentFast: snapshot.cost.byTier.fast.cost,
              spentSmart: snapshot.cost.byTier.smart.cost,
              callsFast: snapshot.cost.byTier.fast.calls,
              callsSmart: snapshot.cost.byTier.smart.calls,
              actualTotal: snapshot.cost.actualTotal,
              baselineTotal: snapshot.cost.baselineTotal,
              savings: snapshot.cost.savings,
              baselineName: `${snapshot.cost.baselineModel.provider}/${snapshot.cost.baselineModel.modelId}`,
            }
          : null;

        // Per-model gauges for the CURRENT model: context window (pi) and
        // cache hit rate (this tier's session-cumulative prompt tokens).
        const contextUsage = (ctx as any).getContextUsage?.() ?? null;
        const cacheStats = state.currentTier
          ? {
              input: state.tierUsage[state.currentTier].tokens.input,
              cacheRead: state.tierUsage[state.currentTier].tokens.cacheRead,
            }
          : null;

        const chains = TIERS.map((tier) => ({
          tier,
          models: (config.tiers[tier]?.models ?? []).map((ref) => {
            const entry = store[ref.provider]?.models.find((m) => m.id === ref.model);
            return { provider: ref.provider, model: ref.model, costIn: entry?.cost?.input ?? null };
          }),
        }));

        const cooldowns: Array<{ provider: string; model: string; remainingMs: number }> = [];
        for (const [key, entry] of state.modelCooldowns) {
          if (entry.until <= now) continue;
          const [provider, ...rest] = key.split("/");
          cooldowns.push({ provider, model: rest.join("/"), remainingMs: entry.until - now });
        }

        const version = (() => {
          try {
            return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version ?? "?";
          } catch {
            return "?";
          }
        })();

        const currentGear = config.routing.economics?.mode ?? "default";
        const otherGears = (Object.keys(ECONOMIC_MODE_PRESETS) as EconomicMode[])
          .filter((m) => m !== currentGear)
          .map((m) => ({
            cmd: `/router ${m}`,
            label: m === "eco" ? "save more" : m === "sport" ? "smarter sooner" : "balanced",
            theta: 1 / ECONOMIC_MODE_PRESETS[m],
          }));

        const input: StatusPanelInput = {
          version,
          enabled: config.enabled,
          routingMode: config.routing.mode,
          currentTier: state.currentTier,
          currentProvider: state.currentProvider,
          currentModelId: state.currentModelId,
          manualActive: state.manualOverride.active,
          lastDecision: state.lastDecision,
          contextUsage,
          cacheStats,
          money,
          speed: {
            current: snapshot.currentTokensPerSec,
            avg: snapshot.avgTokensPerSec,
            totalTokens: snapshot.totalOutputTokens,
          },
          gear: {
            label: economicModeLabel(config),
            thetaEff: effectiveTheta(config),
            downgradeMemory: config.routing.economics?.downgradeMemory ?? 2,
            cacheAware: config.routing.cacheAware?.enabled === true,
            sameFamily: shareProviderFamily(config),
            sameFamilyFactor: sameFamilyThetaFactor(config),
          },
          otherGears,
          chains,
          cooldowns,
          judgeModel: judgeModelDisplay(config),
          windowGlyphs: state.window.slice(-10).map((e) => e.tier),
          orchestration: {
            mode: config.orchestration.mode,
            active: state.orchestration.active,
            spend: state.orchestration.spend,
            workers: state.orchestration.done,
            detail: state.orchestration.active
              ? `round ${state.orchestration.rounds}/${config.orchestration.maxRounds}, workers ${state.orchestration.done}/${state.orchestration.spawned}` +
                (state.orchestration.pendingDispatches > 0 ? `, ${state.orchestration.pendingDispatches} in flight` : "")
              : undefined,
            audit: state.lastAudit
              ? state.lastAudit.violations.length > 0
                ? `⛔ ${state.lastAudit.violations.length} issue(s)${state.lastAudit.llm ? ` (LLM: ${state.lastAudit.llm.verdict})` : ""}`
                : `✓ clean${state.lastAudit.llm ? ` (LLM: ${state.lastAudit.llm.verdict})` : ""}${state.lastAudit.selfExecuted ? " (self-executed)" : ""}`
              : null,
          },
          configSource: getConfigSource(),
          profile: {
            name: state.activeProfile,
            // The Judge chain IS the Fast chain in fast-chain mode, so a
            // profile that replaced Fast also replaced the Judge. Disclosed
            // here rather than left to be discovered (SPEC §9.6).
            judgeFollowsFastChain:
              state.activeProfile !== null &&
              normalizeJudgeMode(config.routing.judge) === "fast-chain" &&
              base?.profiles?.[state.activeProfile]?.fast !== undefined,
            // A profile that was removed from the config while selected is
            // stale — the session runs the configured chains.
            defined: state.activeProfile === null || base?.profiles?.[state.activeProfile] !== undefined,
          },
          now,
        };

        await ctx.ui.custom<null>((_tui, theme, _keybindings, done) => {
          return new StatusPanel(theme, assembleStatusData(input), () => done(null)) as any;
        });
        updateStatus(ctx.ui);
        return;
      }

      // Default: compact status
      ctx.ui.notify(
        `${config.enabled ? "" : "⛔ "}${formatTierDisplay(state.currentTier, state.currentModelId)}${state.manualOverride.active ? " (manual)" : ""}`,
        "info",
      );
    },
  });

  // ── /route-force ──────────────────────────────────────────────
  pi.registerCommand("route-force", {
    description: "Force a specific tier or model for the next turn: /route-force <tier|provider/model>",
    getArgumentCompletions: (prefix: string) => {
      const opts = ["fast", "smart", "auto"].filter((c) => c.startsWith(prefix));
      return opts.length > 0 ? opts.map((c) => ({ value: c, label: c })) : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (!arg || arg === "auto") {
        clearManualOverride(getState());
        ctx.ui.notify("pi-shift-router: Manual override cleared", "info");
        return;
      }

      if (isValidTier(arg)) {
        onManualOverrideTier(arg);
        ctx.ui.notify(`pi-shift-router: ${tierEmoji(arg)} Forcing "${tierLabel(arg, getConfig())}" tier`, "info");
        return;
      }

      // provider/model
      const parts = arg.split("/");
      if (parts.length === 2) {
        setManualOverrideModel(getState(), parts[0], parts[1]);
        ctx.ui.notify(`pi-shift-router: 🎯 Forcing ${parts[0]}/${parts[1]}`, "info");
        return;
      }

      ctx.ui.notify('Usage: fast, smart, auto, or provider/model-id', "error");
    },
  });
}
