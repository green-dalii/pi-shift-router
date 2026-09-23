/**
 * pi-shift-router — Config wizard menu matching tests
 *
 * The wizard's `ctx.ui.select()` returns the full option label (emoji
 * prefixes included). Matching on those emoji is collision-prone — both
 * "🧠 Smart" and "🧠 Cache-aware routing" start with 🧠, which silently
 * routed Cache-aware into the Smart editor (regression fixed in v0.10.0).
 * These tests lock the keyword-based matching so a label edit can't
 * reintroduce a routing bug.
 */

import { describe, it, expect } from "vitest";
import {
  JUDGE_MODE_ORDER,
  matchMenuChoice,
  judgeSummary,
  judgeModeOptions,
  decisionSetupGuide,
  toggleRow,
  TOGGLE_LEGEND,
  matchSaveScope,
  chatCapableModels,
} from "../src/commands.js";

describe("matchMenuChoice", () => {
  it("routes Cache-aware before Smart (emoji collision regression)", () => {
    // "🔒 Cache-aware routing" must NOT be captured by the Smart branch.
    expect(matchMenuChoice("🔒 Cache-aware routing")).toBe("cache");
    // "🧠 Smart — 2 model(s) (CTO: direction, review, hard problems)"
    expect(matchMenuChoice("🧠 Smart — 2 model(s)  (CTO: direction, review, hard problems)")).toBe("smart");
  });

  it("matches every main-menu option by keyword", () => {
    expect(matchMenuChoice("🦾 Fast — 1 model(s)  (engineer: execution, daily coding)")).toBe("fast");
    expect(matchMenuChoice("🎨 UX settings")).toBe("ux");
    expect(matchMenuChoice("💾 Save & exit")).toBe("done");
    expect(matchMenuChoice("🚫 Discard & exit")).toBe("cancel");
    expect(matchMenuChoice("")).toBe("cancel");
  });

  it("does not confuse Smart with Cache-aware regardless of order", () => {
    expect(matchMenuChoice("🧠 Smart — 0 model(s)")).toBe("smart");
    expect(matchMenuChoice("🔒 Cache-aware routing")).toBe("cache");
  });
});

describe("matchSaveScope", () => {
  it("maps save-destination labels to scopes", () => {
    expect(matchSaveScope("📁 Project — <cwd>/.pi/pi-shift-router.json (shareable with team)")).toBe("project");
    expect(matchSaveScope("👤 User — ~/.pi/agent/pi-shift-router.json (personal)")).toBe("user");
    expect(matchSaveScope("🚫 Cancel save")).toBeNull();
    expect(matchSaveScope("")).toBeNull();
  });
});

describe("Judge menu (SPEC §8.6)", () => {
  it("routes the Judge row to its own menu choice", () => {
    expect(matchMenuChoice("🧭 Judge — reuse Fast tier chain")).toBe("judge");
    expect(matchMenuChoice("🧭 Judge — decision: typesafe/jev-1.13")).toBe("judge");
  });

  it("keeps Fast/Smart/Cache rows unambiguous", () => {
    expect(matchMenuChoice("🦾 Fast — 2 model(s)  (engineer: execution, daily coding)")).toBe("fast");
    expect(matchMenuChoice("🧠 Smart — 2 model(s)  (CTO: direction, review, hard problems)")).toBe("smart");
    expect(matchMenuChoice("🔒 Cache-aware routing")).toBe("cache");
  });

  it("shows what is actually judging when Jev was chosen but is unusable", () => {
    const cfg = (judge?: any) => ({ routing: { judge } }) as any;
    expect(judgeSummary(cfg({ mode: "decision", models: [{ provider: "typesafe", model: "jev-latest", priority: 1 }] }), 0)).toBe(
      "Jev unavailable — LLM judge active",
    );
  });

  it("summarizes each judge mode for the menu label", () => {
    const cfg = (judge?: any) => ({ routing: { judge } }) as any;
    expect(judgeSummary(cfg(undefined))).toBe("reuse Fast tier chain (LLM)");
    expect(judgeSummary(cfg({ mode: "fast-chain" }))).toBe("reuse Fast tier chain (LLM)");
    expect(judgeSummary(cfg({ mode: "custom", models: [] }))).toContain("no models");
    expect(judgeSummary(cfg({ mode: "custom", models: [{ provider: "p", model: "m", priority: 1 }] }))).toBe("dedicated: p/m");
    expect(
      judgeSummary(
        cfg({
          mode: "decision",
          models: [
            { provider: "typesafe", model: "jev-1.13.0", priority: 1 },
            { provider: "typesafe", model: "jev-mini", priority: 2 },
          ],
        }),
      ),
    ).toBe("Jev (Beta): typesafe/jev-1.13.0 +1");
  });
});

describe("Judge mode UX (SPEC §8.6)", () => {
  it("uses the project's compass glyph for Judge — never the scales", () => {
    // 🧭 is the Judge glyph everywhere (status bar, stats, status panel).
    expect(judgeModeOptions("fast-chain", 0).join("\n")).not.toContain("⚖️");
    expect(decisionSetupGuide().join("\n")).toContain("🧭 Judge");
  });

  it("marks the current mode with ● and the others with ○", () => {
    for (const mode of ["fast-chain", "custom", "decision"] as const) {
      const opts = judgeModeOptions(mode, 1);
      expect(opts.filter((o) => o.startsWith("● "))).toHaveLength(1);
      expect(opts.filter((o) => o.startsWith("○ "))).toHaveLength(2);
    }
    expect(judgeModeOptions("custom", 1)[1]).toContain("🔬 Dedicated Judge LLM chain");
  });

  it("keeps one space between every emoji and its label (width regression guard)", () => {
    // A glyph with a different advance width used to collapse this gap (🛡 → 🔒).
    for (const line of [...judgeModeOptions("fast-chain", 2), ...decisionSetupGuide()].filter((l) =>
      /^[●○]?\s*\p{Extended_Pictographic}/u.test(l),
    )) {
      expect(line).toMatch(/^[●○]? ?\p{Extended_Pictographic}[\uFE0F]? [A-Za-z0-9(]/u);
    }
  });

  it("names the Fast-tier glyph on the reuse row (matching the tier menu)", () => {
    expect(judgeModeOptions("fast-chain", 1)[0]).toBe("● 🦾 Reuse the Fast tier chain (default)");
  });

  it("says none available instead of a bare 0, and explains setup concretely", () => {
    expect(judgeModeOptions("decision", 0)[2]).toContain("none available yet");
    expect(judgeModeOptions("decision", 3)[2]).toContain("3 available");
    const guide = decisionSetupGuide().join("\n");
    expect(guide).toContain("typesafe-decisions");
    expect(guide).toContain("if it stops answering, routing falls back and tells you");
  });
});

describe("Wizard indicator vocabulary — one idiom per semantics", () => {
  it("marks independent toggles as checkboxes (☑ on / ☐ off)", () => {
    expect(toggleRow("Quiet mode — no inline toast notifications", true)).toBe("☑ Quiet mode — no inline toast notifications");
    expect(toggleRow("Status bar — show current tier/model in footer", false)).toBe("☐ Status bar — show current tier/model in footer");
  });

  it("keeps exclusive pickers on circles (● current / ○ other)", () => {
    expect(judgeModeOptions("decision", 1)[2]).toBe("● 🧮 Jev — decision model (Beta) — 1 available");
    expect(judgeModeOptions("fast-chain", 1)[0]).toBe("● 🦾 Reuse the Fast tier chain (default)");
  });

  it("never mixes the two idioms on one row", () => {
    const toggle = toggleRow("Label", true);
    expect(toggle).not.toMatch(/[●○]/);
    for (const opt of judgeModeOptions("decision", 2)) {
      expect(opt).not.toMatch(/[☑☐]/);
    }
  });

  it("keeps one space after the glyph in both idioms", () => {
    expect(toggleRow("Label", true)).toMatch(/^[☑☐] \S/);
    expect(toggleRow("Label", false)).toMatch(/^[☑☐] \S/);
  });

  it("names the toggle glyphs in the title (a bare box is easy to misread)", () => {
    expect(TOGGLE_LEGEND).toBe("(☑ on · ☐ off)");
  });

  it("has no ✔-suffix style left anywhere in the wizard copy", () => {
    for (const line of [...judgeModeOptions("custom", 1), ...decisionSetupGuide(), toggleRow("Label", true)]) {
      expect(line).not.toContain("✔");
    }
  });
});

describe("chatCapableModels — judge-only endpoints never reach a tier picker", () => {
  it("drops decision-protocol models (pi cannot stream them)", () => {
    const models: any = [
      { provider: "typesafe", id: "jev-1.13.0", api: "typesafe-decisions" },
      { provider: "commandcode", id: "deepseek-v4-flash", api: "openai-completions" },
      { provider: "typesafe", id: "jev-latest", api: "typesafe-decisions" },
    ];
    expect(chatCapableModels(models).map((m) => m.id)).toEqual(["deepseek-v4-flash"]);
  });

  it("keeps everything when no decision endpoints are configured", () => {
    const models: any = [
      { provider: "a", id: "x", api: "openai-completions" },
      { provider: "b", id: "y", api: "anthropic-messages" },
    ];
    expect(chatCapableModels(models)).toHaveLength(2);
  });
});

describe("Jev is an opt-in Beta judge (SPEC §8.6)", () => {
  it("leads with the legacy default, not Jev", () => {
    const rows = judgeModeOptions("fast-chain", 2);
    expect(rows[0]).toBe("● 🦾 Reuse the Fast tier chain (default)");
    expect(JUDGE_MODE_ORDER).toEqual(["fast-chain", "custom", "decision"]);
  });

  it("labels Jev as Beta and keeps it last", () => {
    const rows = judgeModeOptions("fast-chain", 2);
    expect(rows[2]).toContain("🧮 Jev — decision model (Beta)");
    expect(rows[2]).toContain("2 available");
  });

  it("keeps both LLM judges ahead of the Beta option", () => {
    const rows = judgeModeOptions("decision", 1);
    expect(rows[0]).toContain("🦾 Reuse the Fast tier chain");
    expect(rows[1]).toContain("🔬 Dedicated Judge LLM chain");
  });

  it("says Jev is less battle-tested and that routing falls back regardless", () => {
    const guide = decisionSetupGuide().join("\n");
    expect(guide).toContain("Beta");
    expect(guide).toContain("falls back either way");
  });
});

