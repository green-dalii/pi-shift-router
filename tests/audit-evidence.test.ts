/**
 * pi-shift-router — Audit evidence extraction + domain tests (SPEC §9.3, v1.4.0)
 *
 * New contract:
 * - extractWorkerResults reads pi's NATIVE message schema
 *   (`role: "toolResult"` + `toolName`), returning only subagent tool results;
 *   OpenAI-style `role: "tool"` fixtures remain supported.
 * - The audit's domain is DELEGATED runs (spawned ≥ 1). Self-executed turns
 *   (spawned = 0) run only the deterministic CTO-summary check, get
 *   `selfExecuted: true`, and NEVER trigger the LLM pass or worker-grounding
 *   violations.
 */

import { describe, expect, it, vi } from "vitest";
import { auditOrchestration, extractWorkerResults } from "../src/audit.js";
import type { OrchestrationAudit } from "../src/types.js";

const msgs = (finalAssistant: string) => [
  { role: "user", content: "do the thing" },
  { role: "assistant", content: [{ type: "text", text: finalAssistant }] },
];

const ENDPOINT = [{ baseUrl: "http://x", apiType: "openai-completions", apiKey: "k", modelId: "m", provider: "p" }] as never;

// ─── Pi-native evidence extraction ────────────────────────────────
describe("extractWorkerResults — pi-native schema (role: toolResult)", () => {
  it("collects subagent tool results by toolName", () => {
    const m = [
      { role: "toolResult", toolCallId: "t1", toolName: "subagent", content: [{ type: "text", text: "worker delivered A" }], isError: false },
      { role: "toolResult", toolCallId: "t2", toolName: "subagent", content: [{ type: "text", text: "worker delivered B" }], isError: false },
    ];
    const out = extractWorkerResults(m);
    expect(out).toContain("worker delivered A");
    expect(out).toContain("worker delivered B");
  });

  it("excludes non-subagent tool results (CTO's own read/bash/grep)", () => {
    const m = [
      { role: "toolResult", toolCallId: "r1", toolName: "read", content: [{ type: "text", text: "file contents" }], isError: false },
      { role: "toolResult", toolCallId: "b1", toolName: "bash", content: [{ type: "text", text: "shell output" }], isError: false },
    ];
    expect(extractWorkerResults(m)).toBe("");
  });

  it("supports string content on toolResult messages", () => {
    const m = [
      { role: "toolResult", toolCallId: "t1", toolName: "subagent", content: "plain worker text", isError: false },
    ];
    expect(extractWorkerResults(m)).toContain("plain worker text");
  });

  it("keeps OpenAI-style role: tool fixtures working", () => {
    const m = [
      { role: "tool", toolCallId: "t1", content: [{ type: "text", text: "legacy output" }] },
    ];
    expect(extractWorkerResults(m)).toContain("legacy output");
  });

  it("truncates each result to maxCharsPerResult", () => {
    const m = [
      { role: "toolResult", toolCallId: "t1", toolName: "subagent", content: [{ type: "text", text: "x".repeat(5000) }], isError: false },
    ];
    const out = extractWorkerResults(m, 100);
    expect(out.length).toBeLessThanOrEqual(100);
  });
});

// ─── Audit domain: self-executed turns ────────────────────────────
describe("audit domain — self-executed orchestration turns (spawned = 0)", () => {
  const base = {
    spawned: 0,
    done: 0,
    rounds: 0,
    escalations: 0,
    maxRounds: 3,
    escalationThreshold: 2,
  };

  it("marks selfExecuted and never calls the LLM", async () => {
    const spy = vi.fn(async () => ({ verdict: "pass" as const, issues: [] }));
    const audit = await auditOrchestration({
      ...base,
      messages: msgs("CTO summary: planned / delegated / reviewed+accepted / remains"),
      enabled: true,
      goal: "verify the code",
      ctoSummary: "CTO summary: verified by direct reads",
      workerResults: "",
      endpoints: ENDPOINT,
      timeoutMs: 100,
      llmCall: spy,
    });
    expect(audit.selfExecuted).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("produces no worker-grounding violations for a self-executed run", async () => {
    const audit = await auditOrchestration({
      ...base,
      messages: msgs("CTO summary: done directly, no workers needed"),
      enabled: true,
      goal: "verify the code",
      ctoSummary: "CTO summary: done",
      workerResults: "",
      endpoints: ENDPOINT,
      timeoutMs: 100,
      llmCall: async () => ({ verdict: "flag" as const, issues: ["would flag if called"] }),
    });
    expect(audit.violations).toEqual([]);
  });

  it("does NOT flag a missing CTO summary on a self-executed turn", async () => {
    // The CTO-summary output contract only engages when workers were actually
    // spawned (spawned >= 1). A self-executed turn with no summary is a normal
    // smart answer, not an unclosed delegation — no violation, no warning.
    const audit = await auditOrchestration({
      ...base,
      messages: msgs("it works, trust me"),
      enabled: true,
      goal: "verify",
      ctoSummary: "it works, trust me",
      workerResults: "",
      endpoints: ENDPOINT,
      timeoutMs: 100,
      llmCall: async () => ({ verdict: "pass" as const, issues: [] }),
    });
    expect(audit.selfExecuted).toBe(true);
    expect(audit.violations).toEqual([]);
  });
});

// ─── Audit domain: delegated turns unchanged ──────────────────────
describe("audit domain — delegated runs still run the LLM pass", () => {
  it("still flags a missing CTO summary on a DELEGATED run (output contract)", async () => {
    // Workers were spawned (spawned >= 1) → the CTO owes an acceptance report
    // over their results; a missing summary stays a real violation.
    const audit = await auditOrchestration({
      spawned: 1,
      done: 1,
      rounds: 1,
      escalations: 0,
      maxRounds: 3,
      escalationThreshold: 2,
      messages: msgs("it works, trust me"),
      enabled: true,
      goal: "verify",
      ctoSummary: "it works, trust me",
      workerResults: "worker output",
      endpoints: ENDPOINT,
      timeoutMs: 100,
      llmCall: async () => ({ verdict: "pass" as const, issues: [] }),
    });
    expect(audit.violations.some((v) => v.includes("CTO summary"))).toBe(true);
  });

  it("calls the LLM with extracted worker results", async () => {
    let seenWorkers = "";
    const spy = async (_goal: string | undefined, _cto: string, workers: string) => {
      seenWorkers = workers;
      return { verdict: "pass" as const, issues: [] };
    };
    const audit = await auditOrchestration({
      spawned: 1,
      done: 1,
      rounds: 1,
      escalations: 0,
      maxRounds: 3,
      escalationThreshold: 2,
      messages: [
        ...msgs("CTO summary: planned / delegated / reviewed+accepted / remains"),
        { role: "toolResult", toolCallId: "t1", toolName: "subagent", content: [{ type: "text", text: "worker grounded output" }], isError: false },
      ],
      enabled: true,
      goal: "refactor auth",
      ctoSummary: "CTO summary",
      workerResults: "worker grounded output", // index.ts extracts this from the transcript
      endpoints: ENDPOINT,
      timeoutMs: 100,
      llmCall: spy,
    });
    expect(audit.selfExecuted).toBeFalsy();
    expect(seenWorkers).toContain("worker grounded output");
  });
});
