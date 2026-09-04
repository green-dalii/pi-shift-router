/**
 * pi-shift-router — Orchestration acceptance audit tests (SPEC §9.3)
 *
 * Covers the deterministic half of the audit (completeness, CTO-summary
 * detection, cap flag, violation assembly) and the LLM verdict parser with
 * an injected stub — no network.
 */

import { describe, expect, it } from "vitest";
import {
  auditOrchestration,
  deterministicAudit,
  extractFinalAssistantText,
  extractWorkerResults,
  hasCtoSummary,
  parseAuditorVerdict,
} from "../src/audit.js";
import type { OrchestrationAudit } from "../src/types.js";

const msgs = (finalAssistant: string) => [
  { role: "user", content: "do the thing" },
  { role: "assistant", content: [{ type: "text", text: finalAssistant }] },
];

describe("extractFinalAssistantText", () => {
  it("returns the last assistant text (array content)", () => {
    const m = msgs("CTO summary: planned / delegated / reviewed+accepted / remains");
    expect(extractFinalAssistantText(m)).toContain("CTO summary");
  });
  it("returns empty when no assistant message", () => {
    expect(extractFinalAssistantText([{ role: "user", content: "hi" }])).toBe("");
  });
  it("handles string content", () => {
    expect(extractFinalAssistantText([{ role: "assistant", content: "plain" }])).toBe("plain");
  });
});

describe("extractWorkerResults", () => {
  it("collects tool-result text blocks", () => {
    const m = [
      { role: "tool", toolCallId: "t1", content: [{ type: "text", text: "worker output A" }] },
      { role: "tool", toolCallId: "t2", content: "worker output B" },
    ];
    const out = extractWorkerResults(m);
    expect(out).toContain("worker output A");
    expect(out).toContain("worker output B");
  });
  it("ignores non-result messages", () => {
    expect(extractWorkerResults([{ role: "user", content: "nope" }])).toBe("");
  });
});

describe("hasCtoSummary", () => {
  it("accepts the marker token", () => {
    expect(hasCtoSummary("CTO summary: all good")).toBe(true);
  });
  it("accepts two content markers without the token", () => {
    expect(hasCtoSummary("Planned X, delegated Y, accepted Z. Remains: none.")).toBe(true);
  });
  it("rejects ordinary text", () => {
    expect(hasCtoSummary("I finished the task. Everything works.")).toBe(false);
  });
  it("rejects empty", () => {
    expect(hasCtoSummary("")).toBe(false);
  });
});

describe("deterministicAudit", () => {
  const base = {
    spawned: 2,
    done: 2,
    rounds: 1,
    escalations: 0,
    maxRounds: 3,
    escalationThreshold: 2,
  };
  it("passes when complete + summary present", () => {
    const r = deterministicAudit({ ...base, messages: msgs("CTO summary: planned / delegated / reviewed+accepted / remains") });
    expect(r.complete).toBe(true);
    expect(r.hasCtoSummary).toBe(true);
    expect(r.capHit).toBe(false);
    expect(r.violations).toEqual([]);
  });
  it("flags missing worker results", () => {
    const r = deterministicAudit({ ...base, done: 1, messages: msgs("CTO summary: ok") });
    expect(r.complete).toBe(false);
    expect(r.violations.join()).toContain("worker results incomplete");
  });
  it("flags missing CTO summary", () => {
    const r = deterministicAudit({ ...base, messages: msgs("it works, trust me") });
    expect(r.hasCtoSummary).toBe(false);
    expect(r.violations.join()).toContain("no CTO summary");
  });
  it("flags a hard cap hit", () => {
    const r = deterministicAudit({
      ...base,
      rounds: 3,
      messages: msgs("CTO summary: wrapped up at cap"),
    });
    expect(r.capHit).toBe(true);
    expect(r.violations.join()).toContain("hard cap");
  });
  it("treats zero spawned as complete", () => {
    const r = deterministicAudit({ ...base, spawned: 0, done: 0, capHitBase: true, messages: msgs("CTO summary: simple, did it myself") });
    expect(r.complete).toBe(true);
    expect(r.capHit).toBe(false);
  });
});

describe("parseAuditorVerdict", () => {
  it("parses pass", () => {
    expect(parseAuditorVerdict('{"verdict":"pass","issues":[]}')).toEqual({ verdict: "pass", issues: [] });
  });
  it("parses flag with issues", () => {
    const r = parseAuditorVerdict('{"verdict":"flag","issues":["no review found","ignored failure"]}');
    expect(r?.verdict).toBe("flag");
    expect(r?.issues).toHaveLength(2);
  });
  it("falls back to bare keyword", () => {
    expect(parseAuditorVerdict("flag")).toEqual({ verdict: "flag", issues: [] });
  });
  it("returns null on junk", () => {
    expect(parseAuditorVerdict("asdf 123")).toBeNull();
  });
});

describe("auditOrchestration", () => {
  const base = {
    spawned: 1,
    done: 1,
    rounds: 1,
    escalations: 0,
    maxRounds: 3,
    escalationThreshold: 2,
  };
  it("threads the goal into the LLM call", async () => {
    let seenGoal: string | undefined;
    const stub = async (goal: string | undefined) => {
      seenGoal = goal;
      return { verdict: "pass" as const, issues: [] };
    };
    await auditOrchestration({
      ...base,
      messages: msgs("CTO summary: done"),
      enabled: true,
      goal: "build the auth flow",
      ctoSummary: "CTO summary",
      workerResults: "worker out",
      endpoints: [{ baseUrl: "http://x", apiType: "openai-completions", apiKey: "k", modelId: "m", provider: "p" }] as never,
      timeoutMs: 100,
      llmCall: stub as never,
    });
    expect(seenGoal).toBe("build the auth flow");
  });
  it("attaches LLM pass verdict when enabled + stub returns pass", async () => {
    const stub = async () => ({ verdict: "pass" as const, issues: [] });
    const audit = await auditOrchestration({
      ...base,
      messages: msgs("CTO summary: planned / delegated / reviewed+accepted / remains"),
      enabled: true,
      goal: "refactor auth",
      ctoSummary: "CTO summary",
      workerResults: "worker out",
      endpoints: [{ baseUrl: "http://x", apiType: "openai-completions", apiKey: "k", modelId: "m", provider: "p" }] as never,
      timeoutMs: 100,
      llmCall: stub,
    });
    expect(audit.llm?.verdict).toBe("pass");
    expect(audit.violations).toEqual([]);
  });
  it("appends LLM flag issues to violations", async () => {
    const stub = async () => ({ verdict: "flag" as const, issues: ["worker output is a placeholder, no implementation"] });
    const audit = await auditOrchestration({
      ...base,
      messages: msgs("CTO summary: ok"),
      enabled: true,
      goal: "ship feature X",
      ctoSummary: "CTO summary",
      workerResults: "worker out",
      endpoints: [{ baseUrl: "http://x", apiType: "openai-completions", apiKey: "k", modelId: "m", provider: "p" }] as never,
      timeoutMs: 100,
      llmCall: stub,
    });
    expect(audit.violations.join()).toContain("LLM audit");
  });
  it("skips the LLM pass when disabled", async () => {
    const stub = async () => ({ verdict: "flag" as const, issues: ["x"] });
    const audit = await auditOrchestration({
      ...base,
      messages: msgs("CTO summary: ok"),
      enabled: false,
      llmCall: stub,
    });
    expect(audit.llm).toBeUndefined();
  });
  it("never throws when the LLM call rejects", async () => {
    const stub = async (): Promise<never> => {
      throw new Error("boom");
    };
    const audit: OrchestrationAudit = await auditOrchestration({
      ...base,
      messages: msgs("CTO summary: ok"),
      enabled: true,
      endpoints: [{ baseUrl: "http://x", apiType: "openai-completions", apiKey: "k", modelId: "m", provider: "p" }] as never,
      timeoutMs: 100,
      llmCall: stub as never,
    });
    expect(audit.violations.length).toBeGreaterThanOrEqual(0);
  });
});

// ─── Cooldown-aware audit LLM endpoint pick (v1.4.2, B4) ────────────
//
// The audit LLM used to pin endpoints[0] unconditionally — re-burning an
// endpoint the SAME TURN had just cooled down (e.g. the fast primary 429'd
// and markModelFailed recorded it), eating the full timeout each orchestrated
// turn before returning null. The cooldown predicate is injected by the
// caller; auditOrchestration filters before invoking llmCall.
describe("auditOrchestration — cooldown-aware endpoint filtering", () => {
  const ep = (provider: string, modelId: string) =>
    ({ baseUrl: "http://x", apiType: "openai-completions", apiKey: "k", modelId, provider }) as never;
  const base = {
    spawned: 2,
    done: 2,
    rounds: 1,
    escalations: 0,
    maxRounds: 3,
    escalationThreshold: 2,
    messages: msgs("CTO summary: planned / delegated / reviewed+accepted / remains"),
    enabled: true,
    goal: "g",
    ctoSummary: "CTO summary",
    workerResults: "worker out",
    timeoutMs: 100,
  };

  it("skips endpoints the caller marks as cooled", async () => {
    const seen: Array<string> = [];
    const stub = async (_g: unknown, _c: unknown, _w: unknown, endpoints: Array<{ provider: string; modelId: string }>) => {
      seen.push(...endpoints.map((e) => e.modelId));
      return { verdict: "pass" as const, issues: [] };
    };
    await auditOrchestration({
      ...base,
      endpoints: [ep("p", "cooled-a"), ep("p", "healthy-b")],
      isCool: (provider: string, model: string) => model === "cooled-a",
      llmCall: stub as never,
    });
    expect(seen).toEqual(["healthy-b"]);
  });

  it("skips the LLM pass entirely when every endpoint is cooled (deterministic audit still runs)", async () => {
    let called = 0;
    const stub = async () => {
      called += 1;
      return { verdict: "pass" as const, issues: [] };
    };
    const audit = await auditOrchestration({
      ...base,
      endpoints: [ep("p", "cooled-a"), ep("p", "cooled-b")],
      isCool: () => true,
      llmCall: stub as never,
    });
    expect(called).toBe(0);
    expect(audit.selfExecuted).toBeFalsy();
    expect(audit.auditedAt).toBeGreaterThan(0);
  });

  it("passes all endpoints through when no predicate is given (back-compat)", async () => {
    const seen: Array<string> = [];
    const stub = async (_g: unknown, _c: unknown, _w: unknown, endpoints: Array<{ provider: string; modelId: string }>) => {
      seen.push(...endpoints.map((e) => e.modelId));
      return { verdict: "pass" as const, issues: [] };
    };
    await auditOrchestration({
      ...base,
      endpoints: [ep("p", "a"), ep("p", "b")],
      llmCall: stub as never,
    });
    expect(seen).toEqual(["a", "b"]);
  });
});
