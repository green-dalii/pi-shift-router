/**
 * pi-shift-router — delegation accounting (SPEC §9.3, v1.8.1)
 *
 * A pi-subagents launch is a DISPATCH; the tool result is often only a
 * receipt. These tests pin the five rules from SPEC §9.3:
 *
 * 1. `action`-bearing calls are management: never counted, never capped.
 * 2. A spawn call is a dispatch: spawned+1, pending+1, rounds+1.
 * 3. A launch receipt is not a completion.
 * 4. A completion is a non-receipt tool result or a `subagent-notify` message.
 * 5. In-flight dispatches are bounded by maxRounds.
 */

import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG, type ShiftRouterConfig } from "../src/types.js";
import { createRouterState } from "../src/router.js";
import {
  classifySubagentCall,
  readDispatchReceipt,
  recordDispatch,
  recordCompletion,
  capHit,
  shouldOrchestrate,
  enterOrchestration,
  buildOrchestratorPrompt,
} from "../src/orchestrate.js";
import { deterministicAudit } from "../src/audit.js";

// Verbatim from a real session (2026-08-28T01:23:56Z, pi-subagents 0.83.1).
const LAUNCH_RECEIPT = [
  "Run fan-out: 1/64 used, 63 remaining",
  "Async: worker [3673b6d1-2f1f-4dc6-9ef7-10c06f998aaf]",
  "",
  "The async run is detached and running in the background.",
  "You are in an interactive session. By default, return control to the user now;",
].join("\n");

const WORKFLOW_RECEIPT = [
  "Run fan-out: 0/64 used, 64 remaining",
  "Async workflow [a8171a67-e5a2-4bd5-97d3-c6e0d39206fd]",
  "",
  "Detached. Return control to the user now.",
].join("\n");

// Verbatim shape of a foreground worker result (2026-09-22T01:46:20Z).
const FINAL_REPORT = [
  "Run fan-out: 1/64 used, 63 remaining",
  "---",
  "## Report",
  "### 1. Files changed",
].join("\n");

function makeConfig(partial?: Partial<ShiftRouterConfig>): ShiftRouterConfig {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ShiftRouterConfig;
  if (partial) {
    for (const [k, v] of Object.entries(partial as Record<string, unknown>)) {
      (cfg as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return cfg;
}

function activeState() {
  const state = createRouterState();
  enterOrchestration(state);
  return state;
}

describe("classifySubagentCall", () => {
  it("a call with agent/task is a spawn", () => {
    expect(classifySubagentCall({ agent: "worker", task: "do it" })).toBe("spawn");
  });

  it("a call with action is management, whatever else it carries", () => {
    for (const action of ["status", "list", "models", "resume", "steer", "stop"]) {
      expect(classifySubagentCall({ action, id: "run-1", agent: "worker" })).toBe("manage");
    }
  });

  it("workflow selectors are their own kind", () => {
    expect(classifySubagentCall({ workflow: true })).toBe("workflow");
    expect(classifySubagentCall({ workflow: "./wf.js" })).toBe("workflow");
    expect(classifySubagentCall({ workflowScript: "return 1" })).toBe("workflow");
  });

  it("tolerates a non-object input", () => {
    expect(classifySubagentCall(undefined)).toBe("spawn");
    expect(classifySubagentCall("agent=worker")).toBe("spawn");
  });
});

describe("readDispatchReceipt", () => {
  it("recognises a background launch receipt and extracts the run id", () => {
    const r = readDispatchReceipt(LAUNCH_RECEIPT);
    expect(r.receipt).toBe(true);
    expect(r.runId).toBe("3673b6d1-2f1f-4dc6-9ef7-10c06f998aaf");
    expect(r.agent).toBe("worker");
  });

  it("recognises a detached workflow receipt", () => {
    const r = readDispatchReceipt(WORKFLOW_RECEIPT);
    expect(r.receipt).toBe(true);
    expect(r.runId).toBe("a8171a67-e5a2-4bd5-97d3-c6e0d39206fd");
    expect(r.agent).toBeUndefined();
  });

  it("a foreground worker result is not a receipt", () => {
    expect(readDispatchReceipt(FINAL_REPORT).receipt).toBe(false);
  });

  it("requires the detached marker, not just an 'Async:' line", () => {
    expect(readDispatchReceipt("Async: worker [3673b6d1-2f1f-4dc6-9ef7-10c06f998aaf]").receipt).toBe(false);
  });

  it("tolerates non-string content", () => {
    expect(readDispatchReceipt(undefined).receipt).toBe(false);
    expect(readDispatchReceipt([{ type: "text" }]).receipt).toBe(false);
  });
});

describe("dispatch vs completion accounting", () => {
  it("a dispatch counts a spawn, a round and one in flight — not a completion", () => {
    const state = activeState();
    expect(recordDispatch(state)).toBe(true);
    expect(state.orchestration.spawned).toBe(1);
    expect(state.orchestration.rounds).toBe(1);
    expect(state.orchestration.pendingDispatches).toBe(1);
    expect(state.orchestration.done).toBe(0);
  });

  it("recordDispatch is a no-op when orchestration is inactive", () => {
    const state = createRouterState();
    expect(recordDispatch(state)).toBe(false);
    expect(state.orchestration.spawned).toBe(0);
  });

  it("a foreground completion settles the dispatch", () => {
    const state = activeState();
    const cfg = makeConfig();
    recordDispatch(state);
    expect(recordCompletion(state, cfg, true)).toBe(true);
    expect(state.orchestration.done).toBe(1);
    expect(state.orchestration.pendingDispatches).toBe(0);
    expect(state.orchestration.workerFailStreak).toBe(0);
  });

  it("a background completion (notify) settles the dispatch", () => {
    const state = activeState();
    const cfg = makeConfig();
    recordDispatch(state);
    recordDispatch(state);
    expect(recordCompletion(state, cfg, true, "notify")).toBe(true);
    expect(state.orchestration.done).toBe(1);
    expect(state.orchestration.pendingDispatches).toBe(1);
  });

  it("a stale notify with nothing pending is ignored", () => {
    const state = activeState();
    const cfg = makeConfig();
    expect(recordCompletion(state, cfg, true, "notify")).toBe(false);
    expect(state.orchestration.done).toBe(0);
  });

  it("a failed completion advances the escalation streak", () => {
    const state = activeState();
    const cfg = makeConfig({ orchestration: { ...DEFAULT_CONFIG.orchestration, escalationThreshold: 2 } });
    recordDispatch(state);
    recordCompletion(state, cfg, false);
    expect(state.orchestration.workerFailStreak).toBe(1);
    expect(state.orchestration.escalations).toBe(0);
    recordDispatch(state);
    recordCompletion(state, cfg, false);
    expect(state.orchestration.escalations).toBe(1);
  });
});

describe("capHit — in-flight dispatches are bounded", () => {
  it("blocks once maxRounds dispatches are still outstanding", () => {
    const state = activeState();
    const cfg = makeConfig({ orchestration: { ...DEFAULT_CONFIG.orchestration, maxRounds: 3, escalationThreshold: 10 } });
    recordDispatch(state);
    recordDispatch(state);
    recordDispatch(state);
    expect(state.orchestration.rounds).toBe(3);
    expect(capHit(state, cfg)).toBe(true);
  });

  it("does not block management while capped (callers must skip manage calls)", () => {
    // capHit is about spawns; index.ts must not apply it to management calls.
    const state = activeState();
    const cfg = makeConfig({ orchestration: { ...DEFAULT_CONFIG.orchestration, maxRounds: 1, escalationThreshold: 10 } });
    recordDispatch(state);
    expect(capHit(state, cfg)).toBe(true);
    expect(classifySubagentCall({ action: "status", id: "r" })).toBe("manage");
  });
});

describe("shouldOrchestrate — the verdict decides, not the running tier", () => {
  const cfg = () => makeConfig();

  it("orchestrates on a smart verdict", () => {
    expect(shouldOrchestrate(cfg(), "smart", undefined, true, true)).toBe(true);
  });

  it("never orchestrates a fast verdict that merely stayed on smart", () => {
    // 43 of 164 logged orchestration turns carried judge=fast; decisionTier
    // stayed smart because the downgrade rules held it. The verdict must win.
    expect(shouldOrchestrate(cfg(), "fast", undefined, true, true)).toBe(false);
  });

  it("honours an explicit orchestrate:true even on a fast verdict", () => {
    expect(shouldOrchestrate(cfg(), "fast", true, true, true)).toBe(true);
  });

  it("honours an explicit veto from the judge", () => {
    expect(shouldOrchestrate(cfg(), "smart", false, true, true)).toBe(false);
  });
});

describe("deterministicAudit — pending is deferred, not missing", () => {
  const base = {
    rounds: 1,
    escalations: 0,
    maxRounds: 3,
    escalationThreshold: 2,
    messages: [],
  };

  it("a still-running worker is not an incomplete result", () => {
    const audit = deterministicAudit({ ...base, spawned: 2, done: 0, pending: 2 });
    expect(audit.complete).toBe(true);
    expect(audit.violations.join(" ")).not.toContain("worker results incomplete");
  });

  it("a worker that vanished is still incomplete", () => {
    const audit = deterministicAudit({ ...base, spawned: 2, done: 1, pending: 0 });
    expect(audit.complete).toBe(false);
    expect(audit.violations.join(" ")).toContain("worker results incomplete");
  });

  it("does not demand a CTO summary while a worker is still running", () => {
    const audit = deterministicAudit({ ...base, spawned: 1, done: 0, pending: 1 });
    expect(audit.violations.join(" ")).not.toContain("no CTO summary");
  });
});
