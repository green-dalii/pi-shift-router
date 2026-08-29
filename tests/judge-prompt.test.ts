/**
 * pi-shift-router — Judge prompt structural tests
 *
 * These tests verify the Judge prompt covers the classification signals
 * we depend on. They do NOT verify LLM behavior (that requires a live API),
 * only that the prompt text contains the concepts.
 *
 * Why this matters: the Judge is the sole classifier (no regex fallback),
 * so a regression that drops a key signal would silently misroute tasks.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PROMPT_PATH = resolve(__dirname, "../src/prompts/judge.md");

function loadPrompt(): string {
  return readFileSync(PROMPT_PATH, "utf-8");
}

describe("Judge prompt structure", () => {
  const prompt = loadPrompt();

  it("file exists and is non-empty", () => {
    expect(prompt.length).toBeGreaterThan(100);
  });

  it("specifies JSON-only output with strict no-prose requirement", () => {
    // Must explicitly forbid prose / markdown fences
    expect(prompt).toMatch(/no markdown fences/i);
    expect(prompt).toMatch(/no extra prose|nothing else/i);
    // Must include both tier literals in the example outputs
    expect(prompt).toMatch(/"tier"\s*:\s*"fast"/);
    expect(prompt).toMatch(/"tier"\s*:\s*"smart"/);
  });

  it("specifies the strict 'no extra prose' wording", () => {
    // A weaker rewrite that only requires the word to 'appear' allows models
    // to emit prose around or instead of the JSON. Keep the strict wording —
    // fields must stay inside the JSON object, never as surrounding text.
    expect(prompt).toMatch(/inside this JSON only|inside the JSON object/i);
    expect(prompt).toMatch(/no second object|no trailing text|one JSON object/i);
  });

  it("defines both tiers with role metaphor", () => {
    // New structure: the tier table + role line name the two roles.
    expect(prompt).toMatch(/engineer mode|engineer/i);
    expect(prompt).toMatch(/cto|judgment driver/i);
    expect(prompt).toMatch(/fast|smart/i);
  });

  // ─── Classification signals ──────────────────────────────────────

  it("covers task content signal", () => {
    // Architectural / review tasks must be in the smart signal
    expect(prompt).toMatch(/architectural design|architecture|design decision/i);
    // Routine execution in the fast signal
    expect(prompt).toMatch(/routine code|writing functions|fixing bugs/i);
  });

  it("classifies document handling as fast (the '检查文档' fix)", () => {
    // Document tasks (read/check/update/format/translate/consistency) are
    // execution, not judgment — they must appear in the fast column/signals.
    expect(prompt).toMatch(/document handling/i);
    expect(prompt).toMatch(/consistency/i);
    // The doc-vs-direction nuance must be spelled out: only direction-setting
    // doc work (new design doc, review that drives rework) escalates.
    expect(prompt).toMatch(/sets direction|direction-setting/i);
    // Explicit few-shot: the exact user phrasing routes fast.
    expect(prompt).toMatch(/检查文档的更新修订/);
  });

  it("classifies tedious/bulk batches as fast", () => {
    expect(prompt).toMatch(/tedious|bulk/i);
    expect(prompt).toMatch(/mechanical replace|batch/i);
  });

  it("covers user explicit intent signal", () => {
    // The fix for "user says 'use最强模型'" issue — must be explicit
    expect(prompt).toMatch(/explicit intent/i);
    // Must mention that user intent overrides task content
    expect(prompt).toMatch(/wins|follow that|override/i);
  });

  it("covers stakes / reversibility signal", () => {
    expect(prompt).toMatch(/stakes|reversib/i);
  });

  it("covers ambiguity signal", () => {
    expect(prompt).toMatch(/ambig/i);
  });

  it("has priority-ordered decision rule", () => {
    expect(prompt).toMatch(/priority order|in order|conflict/i);
    // Explicit intent should be #1 in priority
    expect(prompt).toMatch(/1\..{0,80}explicit intent/is);
  });

  // ─── Bilingual coverage ──────────────────────────────────────────

  it("includes Chinese examples for explicit-intent cases", () => {
    // Cover at least one Chinese phrase for high-quality intent
    expect(prompt).toMatch(/最强大模型|仔细想想|深思熟虑|请认真分析/);
    // And one for low-effort intent
    expect(prompt).toMatch(/别想太多|快速答复|简短回答/);
  });

  it("includes English examples for explicit-intent cases", () => {
    expect(prompt).toMatch(/think carefully|deeply|thoroughly|best model|smartest/i);
    expect(prompt).toMatch(/quick answer|just give me|fast response/i);
  });

  // ─── Coverage of common edge cases ───────────────────────────────

  it("includes acknowledgment examples (fast)", () => {
    expect(prompt).toMatch(/\bok\b|continue|谢谢|继续/);
  });

  it("includes high-stakes / irreversible examples (smart)", () => {
    expect(prompt).toMatch(/deploy|production|security/i);
  });

  // ─── Static structural guards ───────────────────────────────────

  it("does not exceed reasonable length", () => {
    // Prompt is sent on every Judge call; keep it bounded
    // (token-cost matters). 4000 chars is the upper limit.
    expect(prompt.length).toBeLessThan(8000);
  });

  it("does not contain markdown headings after the title", () => {
    // Pi's pi-tui / chat UIs sometimes render `#` headings as bold,
    // which can confuse models trained on instruction-following.
    // Only one `#` heading at the top is allowed.
    const headings = prompt.match(/^#\s+/gm) ?? [];
    expect(headings.length).toBe(1);
  });
});