/**
 * pi-shift-router — orchestrator prompt contract (SPEC §9.3, v1.8.1)
 *
 * The prompt is the only thing that tells the Smart model how to delegate.
 * Each assertion here pins an instruction whose absence was measured in real
 * sessions (issues #57 / #58), so a future rewrite cannot silently drop it.
 */

import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG } from "../src/types.js";
import { buildOrchestratorPrompt } from "../src/orchestrate.js";

const prompt = buildOrchestratorPrompt(DEFAULT_CONFIG, () => false);

describe("orchestrator prompt — instructions the runtime can execute", () => {
  it("runs children in the foreground so the result is reviewable in this turn", () => {
    expect(prompt).toContain("async: false");
  });

  it("names a fresh reviewer for the review step (SPEC §9.3)", () => {
    expect(prompt).toContain('agent: "reviewer"');
  });

  it("drops the self-execution escape hatch that let a run skip delegation", () => {
    expect(prompt).not.toMatch(/just do it yourself/i);
  });

  it("does not point at runs.all, which only exists inside a workflow script", () => {
    expect(prompt).not.toContain("runs.all");
  });

  it("does not restate context: fresh, which belongs in options and is the worker default", () => {
    expect(prompt).not.toContain('context: "fresh"');
    expect(prompt).toContain("fork");
  });
});
