/**
 * pi-shift-router — /router status dashboard (TUI panel).
 *
 * Two layers:
 *   1. assembleStatusData() — PURE view-model builder (unit-tested): turns
 *      router state + stats + config into structured display data.
 *   2. StatusPanel — pi-tui component rendering the view model with theme
 *      colors (opened via ctx.ui.custom, closed with q / Esc).
 *
 * Follows the model-picker pattern: theme is injected by pi's custom()
 * factory; no runtime import of pi-coding-agent (type-only imports are OK).
 */

import { Box, Container, Text, getKeybindings } from "@earendil-works/pi-tui";
import { formatRemaining } from "../failover.js";
import type { Tier } from "../types.js";

// ─── Pure helpers ───────────────────────────────────────────────────

/**
 * Cache hit rate over prompt tokens: cacheRead / (input + cacheRead),
 * rounded to a whole percent. null when the provider reported nothing
 * (no data yet or provider does not report cache fields) — display "n/a".
 */
export function cacheHitPct(stats: { input: number; cacheRead: number } | null): number | null {
  if (!stats) return null;
  const total = stats.input + stats.cacheRead;
  if (total <= 0) return null;
  return Math.round((stats.cacheRead / total) * 100);
}

/** Block bar: ▓ filled / ░ empty, rounded and clamped to [0,1]. */
export function renderBar(ratio: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

/**
 * theta → plain-language "bar" (the Smart upgrade threshold as a percent).
 * Same-family cache-aware routing divides the bar — expressed in words on
 * the panel as "the judge only needs to be X% confident".
 */
export function gearBarPct(theta: number, familyAdjusted: boolean, sameFamilyFactor: number): number {
  const eff = familyAdjusted ? theta / sameFamilyFactor : theta;
  return Math.round(eff * 100);
}

/** Compact token count: 38200 → "38.2k", 200000 → "200.0k", 940 → "940". */
function formatK(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(Math.round(n));
}

/** Dollar display: small amounts get 3 decimals, the rest 2. */
export function formatUsd(n: number): string {
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
}

// ─── View model ─────────────────────────────────────────────────────

export interface StatusPanelInput {
  version: string;
  enabled: boolean;
  routingMode: string;
  currentTier: Tier | null;
  currentProvider: string | null;
  currentModelId: string | null;
  manualActive: boolean;
  lastDecision: { verdict: Tier; confidence?: number; action: string; reason?: string } | null;
  contextUsage: { tokens: number; contextWindow: number } | null;
  cacheStats: { input: number; cacheRead: number } | null;
  money: {
    spentFast: number;
    spentSmart: number;
    callsFast: number;
    callsSmart: number;
    actualTotal: number;
    baselineTotal: number;
    savings: number;
    baselineName: string;
  } | null;
  speed: { current: number; avg: number; totalTokens: number } | null;
  gear: {
    label: string;
    thetaEff: number;
    downgradeMemory: number;
    cacheAware: boolean;
    sameFamily: boolean;
    sameFamilyFactor: number;
  };
  otherGears: Array<{ cmd: string; label: string; theta: number }>;
  chains: Array<{ tier: Tier; models: Array<{ provider: string; model: string; costIn: number | null }> }>;
  cooldowns: Array<{ provider: string; model: string; remainingMs: number }>;
  judgeModel: string;
  windowGlyphs: Tier[];
  orchestration: { mode: string; active: boolean; detail?: string; audit: string | null };
  configSource: { source: "project" | "user" | "default"; path: string | null; userLayerExists: boolean };
  now: number;
}

export interface ChainModelRow {
  idx: number;
  key: string;
  price: string | null;
  cooldownRemainingMs?: number;
  live: boolean;
}

export interface StatusPanelData {
  header: string;
  nowLine: { tierIcon: string; model: string; manual: boolean };
  contextLine: { pct: number; used: string; window: string } | null;
  cacheLine: { pct: number; cached: string; total: string } | null;
  lastLine: { verdict: string; confidence?: number; action: string; reason?: string } | null;
  money: {
    spentFast: number;
    spentSmart: number;
    callsFast: number;
    callsSmart: number;
    actualTotal: number;
    baselineTotal: number;
    savings: number;
    savingsPct: number;
    pctFast: number;
    pctSmart: number;
    baselineName: string;
  } | null;
  speedLine: { current: number; avg: number; totalTokens: string } | null;
  chains: Array<{
    tier: Tier;
    tierIcon: string;
    tierLabel: string;
    models: ChainModelRow[];
  }>;
  health: { judgeModel: string; cooldownCount: number; windowGlyphs: Tier[]; orchLine: string; auditLine: string };
  gearLine: { label: string; barPct: number; downgradeMemory: number; cacheAware: boolean };
  otherGears: Array<{ cmd: string; label: string; barPct: number }>;
  configLine: string;
}

const TIER_ICONS: Record<Tier, string> = { fast: "🦾", smart: "🧠" };

/**
 * Build the dashboard view model. Pure — the component maps this onto
 * theme colors; tests pin every computation here.
 */
export function assembleStatusData(input: StatusPanelInput): StatusPanelData {
  const state = input.enabled ? "ON" : "OFF";

  // Context usage (pi reports null right after compaction / before the
  // next response) — show nothing rather than a fake 0%.
  const contextLine =
    input.contextUsage && input.contextUsage.tokens !== null && input.contextUsage.contextWindow > 0
      ? {
          pct: Math.round((input.contextUsage.tokens / input.contextUsage.contextWindow) * 100),
          used: formatK(input.contextUsage.tokens),
          window: formatK(input.contextUsage.contextWindow),
        }
      : null;

  // Cache hit over the CURRENT tier's session-cumulative prompt tokens.
  const cacheLine = (() => {
    const pct = cacheHitPct(input.cacheStats);
    if (pct === null || !input.cacheStats) return null;
    return {
      pct,
      cached: formatK(input.cacheStats.cacheRead),
      total: formatK(input.cacheStats.input + input.cacheStats.cacheRead),
    };
  })();

  // Money: savings percent derived from the all-smart baseline.
  const money = input.money
    ? {
        ...input.money,
        savingsPct:
          input.money.baselineTotal > 0
            ? Math.round((input.money.savings / input.money.baselineTotal) * 100)
            : 0,
        pctFast:
          input.money.actualTotal > 0
            ? Math.round((input.money.spentFast / input.money.actualTotal) * 100)
            : 0,
        pctSmart:
          input.money.actualTotal > 0
            ? Math.round((input.money.spentSmart / input.money.actualTotal) * 100)
            : 0,
      }
    : null;

  // Chains: mark the live entry only inside the tier that owns it — the
  // same model id can appear under both tiers, and only the DECIDED tier's
  // copy is actually running.
  const liveKey =
    input.currentProvider && input.currentModelId
      ? `${input.currentProvider}/${input.currentModelId}`
      : null;
  const chains = input.chains.map((chain) => ({
    tier: chain.tier,
    tierIcon: TIER_ICONS[chain.tier],
    tierLabel: chain.tier === "fast" ? "Fast" : "Smart",
    models: chain.models.map((m, i) => {
      const key = `${m.provider}/${m.model}`;
      const cd = input.cooldowns.find((c) => `${c.provider}/${c.model}` === key);
      return {
        idx: i + 1,
        key,
        price: m.costIn !== null && m.costIn !== undefined ? `$${m.costIn.toFixed(2)}/M` : null,
        cooldownRemainingMs: cd?.remainingMs,
        live: chain.tier === input.currentTier && key === liveKey,
      };
    }),
  }));

  const gearLine = {
    label: input.gear.label,
    barPct: Math.round(input.gear.thetaEff * 100),
    downgradeMemory: input.gear.downgradeMemory,
    cacheAware: input.gear.cacheAware,
  };
  const familyAdjusted = input.gear.cacheAware && input.gear.sameFamily;
  const otherGears = input.otherGears.map((g) => ({
    cmd: g.cmd,
    label: g.label,
    barPct: gearBarPct(g.theta, familyAdjusted, input.gear.sameFamilyFactor),
  }));

  const configLine =
    input.configSource.source === "project"
      ? `Config: project (${input.configSource.path})${input.configSource.userLayerExists ? " — user layer merged underneath" : ""}`
      : input.configSource.source === "user"
        ? `Config: user (${input.configSource.path})`
        : "Config: defaults (no config file yet)";

  return {
    header: `pi-shift-router v${input.version} — routing ${state} (${input.routingMode})`,
    nowLine: {
      tierIcon: input.currentTier ? TIER_ICONS[input.currentTier] : "—",
      model: input.currentModelId ?? "no model",
      manual: input.manualActive,
    },
    contextLine,
    cacheLine,
    lastLine: input.lastDecision,
    money,
    speedLine: input.speed
      ? { current: input.speed.current, avg: input.speed.avg, totalTokens: formatK(input.speed.totalTokens) }
      : null,
    chains,
    health: {
      judgeModel: input.judgeModel,
      cooldownCount: input.cooldowns.length,
      windowGlyphs: input.windowGlyphs,
      orchLine: `orchestration: 🪄 ${input.orchestration.mode}${input.orchestration.active ? `, ACTIVE${input.orchestration.detail ? ` (${input.orchestration.detail})` : ""}` : ", idle"}`,
      auditLine: `audit: ${input.orchestration.audit ?? "—"}`,
    },
    gearLine,
    otherGears,
    configLine,
  };
}

// ─── TUI component ──────────────────────────────────────────────────

type ThemeLike = {
  fg(color: string, text: string): string;
};

const BAR_WIDTH = 10;

/**
 * Read-only dashboard. q / Esc closes (done(null)). Data is a snapshot —
 * reopen /router status for a fresh one (same as the old notify version).
 */
export class StatusPanel {
  private box = new Box(1, 0);

  constructor(theme: ThemeLike, data: StatusPanelData, private onDone: () => void) {
    const accent = (t: string) => theme.fg("accent", t);
    const success = (t: string) => theme.fg("success", t);
    const warning = (t: string) => theme.fg("warning", t);
    const error = (t: string) => theme.fg("error", t);
    const muted = (t: string) => theme.fg("muted", t);
    const dim = (t: string) => theme.fg("dim", t);
    const add = (text: string) => this.box.addChild(new Text(text, 0, 0));
    const blank = () => add("");
    const section = (title: string) => add(accent(title));

    // Header
    add(accent(data.header.replace(/routing (ON|OFF)/, (_m, s) => (s === "ON" ? success("routing ON") : error("routing OFF")))));
    blank();

    // Now + per-model gauges
    add(`Now: ${data.nowLine.tierIcon} ${data.nowLine.model}${data.nowLine.manual ? muted("  (manual override)") : ""}`);
    if (data.contextLine) {
      const color = data.contextLine.pct > 80 ? warning : accent;
      add(
        `  Context  ${color(renderBar(data.contextLine.pct / 100, BAR_WIDTH))}  ` +
          `${data.contextLine.pct}% · ${data.contextLine.used} / ${data.contextLine.window}`,
      );
    }
    if (data.cacheLine) {
      add(
        `  Cache hit ${success(`${data.cacheLine.pct}%`)}  ` +
          dim(`(${data.cacheLine.cached} of ${data.cacheLine.total} prompt tokens from cache)`),
      );
    }
    if (data.lastLine) {
      const arrow = data.lastLine.action === "upgrade" ? success("↑") : data.lastLine.action === "downgrade" ? warning("↓") : "·";
      add(
        `Last: judge ${data.lastLine.verdict}` +
          (data.lastLine.confidence !== undefined ? ` (conf ${data.lastLine.confidence.toFixed(2)})` : "") +
          ` → ${arrow} ${data.lastLine.action}` +
          (data.lastLine.reason ? muted(` — "${data.lastLine.reason}"`) : ""),
      );
    } else {
      add(dim("Last: no routing decision yet this session"));
    }
    blank();

    // Money
    if (data.money) {
      section("Money · this session");
      add(
        `  saved   ${success(formatUsd(data.money.savings))} of ${formatUsd(data.money.baselineTotal)}  ` +
          success(`(${data.money.savingsPct}%)`) +
          dim(`  vs all-smart: ${data.money.baselineName}`),
      );
      const fastBlocks = renderBar(data.money.pctFast / 100, BAR_WIDTH);
      const smartBlocks = renderBar(data.money.pctSmart / 100, BAR_WIDTH);
      add(
        `  spent   ${formatUsd(data.money.actualTotal)}  ` +
          `fast ${dim(fastBlocks)} ${data.money.pctFast}% · smart ${accent(smartBlocks)} ${data.money.pctSmart}%`,
      );
    }
    if (data.speedLine) {
      add(
        `  speed   ${data.speedLine.current} tok/s (avg ${data.speedLine.avg}) · ${data.speedLine.totalTokens} tokens`,
      );
    }
    blank();

    // Chains — tier on its own line, chain below.
    section("Chains (priority ↓ · price per Mtok in)");
    for (const chain of data.chains) {
      add(`${chain.tierIcon} ${accent(chain.tierLabel)}`);
      for (const m of chain.models) {
        const marker = m.live ? success(" ← live") : "";
        const cd = m.cooldownRemainingMs !== undefined ? warning(` ⏳${formatRemaining(m.cooldownRemainingMs)}`) : "";
        const price = m.price ? dim(`  ${m.price}`) : "";
        add(`     ${m.idx}  ${m.key}${price}${marker}${cd}`);
      }
    }
    blank();

    // Health
    section("Health");
    add(`  judge 🧭 ${data.health.judgeModel} · cooldowns: ${data.health.cooldownCount}`);
    if (data.health.windowGlyphs.length > 0) {
      const glyphs = data.health.windowGlyphs
        .map((t) => (t === "smart" ? accent("●") : muted("●")))
        .join("");
      add(`  recent turns  ${glyphs}   ${dim("● smart · ● fast")}`);
    }
    add(`  ${data.health.orchLine} · ${data.health.auditLine}`);
    blank();

    // How routing decides (plain language — no theta jargon)
    section("How routing decides");
    const ca = data.gearLine.cacheAware
      ? " Cache-aware is on: switching within the same model family keeps your prompt cache warm."
      : "";
    add(
      `  Gear: ${data.gearLine.label} — a turn goes to Smart when the judge is at least ` +
        success(`${data.gearLine.barPct}%`) +
        ` confident; back to Fast after ${data.gearLine.downgradeMemory} straight fast turns.${ca}`,
    );
    if (data.otherGears.length > 0) {
      add(
        dim(
          `  Other gears: ` +
            data.otherGears.map((g) => `${g.cmd} (${g.label} · bar ${g.barPct}%)`).join(" · "),
        ),
      );
    }
    blank();

    // Reference
    add(muted(data.configLine));
    add(dim("                                                   q / Esc close"));

    this.container.addChild(this.box);
  }

  private container = new Container();

  render(width: number): string[] {
    return this.container.render(width);
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.cancel") || data === "q") {
      this.onDone();
    }
  }

  invalidate(): void {
    this.container.invalidate();
  }
}
