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
import type { ShiftRouterConfig, RouterState, Tier, TierEntry, ModelRef, EconomicMode } from "./types.js";
import { TIERS, ECONOMIC_MODE_PRESETS, LEGACY_SAME_FAMILY_THRESHOLD_DEFAULT } from "./types.js";
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
  effectiveReworkPenalty,
  effectiveTheta,
  legacyThetaOverride,
  sameFamilyThetaFactor,
} from "./router.js";
import { resetOrchestration } from "./orchestrate.js";
import { formatStats, computeStats, judgeModelDisplay } from "./stats.js";
import { StatusPanel, assembleStatusData, type StatusPanelInput } from "./tui/status-panel.js";
import { formatRemaining } from "./failover.js";
import {
  getConfigPath,
  getConfigSource,
  userConfigPath,
  loadModelsStore,
  loadAuthStore,
  flattenModels,
  saveConfig,
  invalidateModelsStoreCache,
  invalidateAuthStoreCache,
  isProviderAuthenticated,
  isModelUnavailable,
} from "./config.js";

// ─── Helpers ──────────────────────────────────────────────────────

function formatWindow(window: RouterState["window"]): string {
  if (window.length === 0) return "(empty)";
  const badge: Record<string, string> = { fast: "f", smart: "s", hold: "·" };
  return "[" + window.map((e) => (e.hold ? badge.hold : badge[e.tier] ?? "?")).join(", ") + "]";
}

function tierEntries(config: ShiftRouterConfig): TierEntry[] {
  return TIERS.map((t) => ({
    tier: t,
    label: config.tiers[t].label,
    description: config.tiers[t].description,
    models: config.tiers[t].models.map((m) => ({ provider: m.provider, model: m.model })),
  }));
}

function formatTierList(config: ShiftRouterConfig): string {
  return tierEntries(config)
    .map(
      (e) =>
        `  ${tierEmoji(e.tier)} ${e.label.padEnd(14)} ${e.models.map((m: { provider: string; model: string }) => `${m.provider}/${m.model}`).join(", ") || "(none)"}`,
    )
    .join("\n");
}

// ─── `/route-config` wizard ──────────────────────────────────────

type MenuChoice = "fast" | "smart" | "ux" | "cache" | "done" | "cancel";

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

/** " → 0.22 eff (same-family ÷1.5)" suffix when cache-aware division applies. */
function effectiveThetaEffNote(config: ShiftRouterConfig): string {
  const effective = effectiveTheta(config);
  const base = 1 / Math.max(effectiveReworkPenalty(config), 1);
  if (Math.abs(effective - base) <= 1e-9 || !shareProviderFamily(config)) return "";
  return ` → ${effective.toFixed(2)} eff (same-family ÷${sameFamilyFactorDisplay(config)})`;
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

/** Effective θ for status display (legacy non-default threshold overrides economics). */
function effectiveThetaDisplay(config: ShiftRouterConfig): string {
  const legacy = legacyThetaOverride(config);
  if (legacy !== undefined) return String(legacy);
  return (1 / Math.max(effectiveReworkPenalty(config), 1)).toFixed(2);
}

/**
 * Persist config to whichever file is authoritative (project if it exists,
 * else user, else project as the default write target). All mutating
 * commands go through this — an in-memory mutation alone is lost on the
 * next `onConfigChanged()` reload.
 */
async function persistConfig(config: ShiftRouterConfig, cwd: string): Promise<boolean> {
  const path = getConfigPath();
  const scope = path !== null && path === userConfigPath() ? "user" : "project";
  return saveConfig(config, cwd, scope);
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
 * Map a wizard option label to its menu action.
 *
 * Labels carry decorative emoji prefixes (🦾 🧠 🛡️ …); matching on those is
 * collision-prone — both "🧠 Smart" and "🧠 Cache-aware" start with 🧠, so a
 * `startsWith` on the emoji silently routes Cache-aware into Smart. Instead we
 * match on stable English keywords that are unique across the fixed option
 * labels. Pure + unit-tested so a future label edit can't reintroduce a
 * routing bug. Also used for the provider/UX sub-menus where labels are fixed
 * strings too.
 */
export function matchMenuChoice(label: string): MenuChoice {
  if (label.includes("Cache-aware")) return "cache";
  if (label.includes("Fast")) return "fast";
  if (label.includes("Smart")) return "smart";
  if (label.includes("UX")) return "ux";
  if (label.includes("Save")) return "done";
  return "cancel";
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

async function routeConfigWizard(
  config: ShiftRouterConfig,
  cwd: string,
  ctx: ExtensionCommandContext,
): Promise<boolean> {
  // Force a fresh read of the merged models store AND credentials: pi's
  // catalog, the user's models.json, and auth.json may all have changed since
  // pi started (e.g. /login or /logout while the session is running). The
  // picker must reflect current disk state and only offer authenticated
  // providers — otherwise a provider removed by /logout keeps showing stale
  // ghost models in the list.
  invalidateModelsStoreCache();
  invalidateAuthStoreCache();
  const store = await loadModelsStore();
  const auth = await loadAuthStore();
  const allModels = flattenModels(store).filter((m) => isProviderAuthenticated(m.provider, auth, store));
  if (allModels.length === 0 && Object.keys(store).length > 0) {
    ctx.ui.notify("No authenticated providers — run /login for a provider before configuring tiers", "warning");
  }

  if (allModels.length === 0) {
    ctx.ui.notify("No models found in models-store.json", "error");
    return false;
  }

  type MenuChoice = "fast" | "smart" | "ux" | "cache" | "done" | "cancel";
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
    const choice = await ctx.ui.select("pi-shift-router — Configuration", [
      `🦾 Fast — ${config.tiers.fast.models.length} model(s)  (engineer: execution, daily coding)`,
      `🧠 Smart — ${config.tiers.smart.models.length} model(s)  (CTO: direction, review, hard problems)`,
      "🎨 UX settings",
      "🛡️ Cache-aware routing",
      "💾 Save & exit",
      "🚫 Discard & exit",
    ]);

    if (!choice) return "cancel";
    return matchMenuChoice(choice);
  }

  async function editTier(tier: Tier): Promise<void> {
    const cfg = config.tiers[tier];

    // TUI mode: use the chain editor with add/remove/reorder
    if (ctx.mode === "tui") {
      const unavailableKeys = new Set(
        cfg.models
          .filter((m) => isModelUnavailable(m.provider, m.model, store, auth))
          .map((m) => `${m.provider}/${m.model}`),
      );
      const { createChainEditor } = await import("./tui/fallback-chain-editor.js");
      const updated = await ctx.ui.custom<ModelRef[] | null>(
        (_tui, theme, _keybindings, done) => {
          return createChainEditor({
            items: cfg.models,
            allModels,
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

    const availModels = allModels.filter((m) => m.cost?.input != null);

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
      const { createModelPicker } = await import("./tui/model-picker.js");
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
      if (!pick || pick.includes("Back")) return null;
      for (const m of models) {
        if (pick.includes(`${m.provider}/${m.id}`)) {
          return { provider: m.provider, model: m.id, priority: 1 };
        }
      }
    }
  }

  async function editUX(): Promise<void> {
    const ux = config.ux;
    const lines = [
      `${ux.quietMode ? "☑" : "☐"} Quiet mode — no inline toast notifications`,
      `${ux.statusBar ? "☑" : "☐"} Status bar — show current tier/model in footer`,
      `${ux.inlineToast ? "☑" : "☐"} Inline toast — notify on tier change`,
      `${ux.routerLogVerbose ? "☑" : "☐"} Verbose log — print router decisions to console (debug)`,
      "✅ Done",
    ];

    const pick = await ctx.ui.select("🎨 UX Settings", lines);
    if (!pick || pick.includes("Done")) return;
    if (pick.includes("Quiet")) ux.quietMode = !ux.quietMode;
    if (pick.includes("Status bar")) ux.statusBar = !ux.statusBar;
    if (pick.includes("Inline toast")) ux.inlineToast = !ux.inlineToast;
    if (pick.includes("Verbose log")) ux.routerLogVerbose = !ux.routerLogVerbose;
  }

  async function editCacheAware(): Promise<void> {
    const cache = config.routing.cacheAware ?? {
      enabled: true,
      sameFamilyPenalty: 1.5,
      idleBoundaryMs: 5 * 60_000,
    };
    const lines = [
      `${cache.enabled ? "☑" : "☐"} Cache-aware routing — avoid paying full price for repeated context: when Fast and Smart use the same provider, the router keeps the warm prompt cache by switching models less often (you can toggle this on/off here)`,
      "✅ Done",
    ];

    const pick = await ctx.ui.select("🛡️ Cache-aware Routing", lines);
    if (!pick || pick.includes("Done")) return;
    if (pick.includes("Cache-aware routing")) {
      config.routing.cacheAware = { ...cache, enabled: !cache.enabled };
    }
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
  getState: () => RouterState,
  onConfigChanged: () => void,
  onManualOverrideTier: (tier: Tier) => void,
  updateStatus: (ui: any) => void,
): void {
  // ── /router ──────────────────────────────────────────────────
  pi.registerCommand("router", {
    description: "pi-shift-router: show status, enable/disable",
    getArgumentCompletions: (prefix: string) => {
      const cmds = ["on", "off", "status", "quiet", "verbose", "config", "orchestrate", "eco", "default", "sport"].filter((c) => c.startsWith(prefix));
      return cmds.length > 0 ? cmds.map((c) => ({ value: c, label: c })) : null;
    },
    handler: async (args, ctx) => {
      const config = getConfig();
      const state = getState();
      const arg = args.trim().toLowerCase();

      if (arg === "orchestrate") {
        ctx.ui.notify(
          `pi-shift-router: 🪄 Usage: /router orchestrate auto|off — auto (default): complex tasks → Smart CTO delegates to Fast subagents (requires pi-subagents; without it, plain smart run); off: plain two-tier routing`,
          "info",
        );
        return;
      }
      if (arg === "orchestrate auto") {
        config.orchestration.mode = "auto";
        await persistConfig(config, ctx.cwd);
        onConfigChanged();
        updateStatus(ctx.ui);
        ctx.ui.notify("pi-shift-router: 🪄 Orchestration AUTO — complex tasks will run as Smart-orchestrated loops, simple tasks stay on the plain router", "info");
        return;
      }
      if (arg === "orchestrate off") {
        config.orchestration.mode = "off";
        resetOrchestration(state);
        updateStatus(ctx.ui);
        await persistConfig(config, ctx.cwd);
        onConfigChanged();
        ctx.ui.notify("pi-shift-router: 🪄 Orchestration OFF — back to plain tier routing", "info");
        return;
      }
      if (arg === "orchestrate on") {
        // Legacy alias: "on" meant the same judge-driven behavior; map to auto.
        config.orchestration.mode = "auto";
        await persistConfig(config, ctx.cwd);
        onConfigChanged();
        ctx.ui.notify("pi-shift-router: 🪄 Orchestration AUTO (legacy `on` mapped to auto) — complex tasks orchestrate, simple tasks stay on the plain router", "info");
        return;
      }

      if (arg === "on") {
        config.enabled = true;
        await persistConfig(config, ctx.cwd);
        onConfigChanged();
        updateStatus(ctx.ui);
        ctx.ui.notify("pi-shift-router: ✅ Enabled", "info");
        return;
      }
      if (arg === "off") {
        config.enabled = false;
        await persistConfig(config, ctx.cwd);
        onConfigChanged();
        updateStatus(ctx.ui);
        ctx.ui.notify("pi-shift-router: ⛔ Disabled", "info");
        return;
      }
      if (arg === "config") {
        await routeConfigWizard(getConfig(), ctx.cwd, ctx);
        onConfigChanged();
        updateStatus(ctx.ui);
        // Show which layer is now authoritative — a wizard save may have
        // created the project file (default write target) just now.
        ctx.ui.notify(`pi-shift-router: ${formatConfigSource()}`, "info");
        return;
      }
      if (arg === "quiet") {
        config.ux.quietMode = !config.ux.quietMode;
        await persistConfig(config, ctx.cwd);
        onConfigChanged();
        ctx.ui.notify(`pi-shift-router: ${config.ux.quietMode ? "🔇 Quiet" : "🔊 Notifications"}`, "info");
        return;
      }
      if (arg === "verbose" || arg === "log") {
        config.ux.routerLogVerbose = !config.ux.routerLogVerbose;
        await persistConfig(config, ctx.cwd);
        onConfigChanged();
        ctx.ui.notify(
          `pi-shift-router: ${config.ux.routerLogVerbose ? "📝 Verbose logging ON" : "📝 Verbose logging OFF"}`,
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
        config.routing.economics = { ...(config.routing.economics ?? { reworkPenalty: 3, downgradeMemory: 2 }), mode };
        await persistConfig(config, ctx.cwd);
        onConfigChanged();
        updateStatus(ctx.ui);
        const theta = (1 / R).toFixed(2);
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
        const snapshot = computeStats(state, config, now, store);
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
            detail: state.orchestration.active
              ? `round ${state.orchestration.rounds}/${config.orchestration.maxRounds}, workers ${state.orchestration.done}/${state.orchestration.spawned}`
              : undefined,
            audit: state.lastAudit
              ? state.lastAudit.violations.length > 0
                ? `⛔ ${state.lastAudit.violations.length} issue(s)${state.lastAudit.llm ? ` (LLM: ${state.lastAudit.llm.verdict})` : ""}`
                : `✓ clean${state.lastAudit.llm ? ` (LLM: ${state.lastAudit.llm.verdict})` : ""}${state.lastAudit.selfExecuted ? " (self-executed)" : ""}`
              : null,
          },
          configSource: getConfigSource(),
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
