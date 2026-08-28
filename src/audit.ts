/**
 * pi-shift-router — Orchestration acceptance audit (SPEC §9.3, safety-net review)
 *
 * After an orchestrated turn ends, this module verifies the CTO actually
 * closed the loop: every spawned worker reported back, the final assistant
 * message carries a CTO summary, and (when the audit LLM is reachable) the
 * acceptance claim is grounded in the worker results — not an unchecked
 * "done".
 *
 * Two layers, both best-effort and never blocking (the turn has already
 * finished when the audit runs):
 * - Deterministic checks (free, always run): worker completeness, CTO-summary
 *   markers, hard-cap flag.
 * - LLM audit (config-gated, one small call on the fast tier): reads the CTO
 *   summary + worker outputs and flags ungrounded acceptance.
 *
 * Design constraints:
 * - Pure functions at the top; IO (LLM fetch) injected via an optional
 *   `llmCall` parameter so the deterministic core stays unit-testable.
 * - Errors are values: any audit failure degrades to a warn, never a crash.
 * - The audit never modifies state it audits — it only *reports* (via
 *   `state.lastAudit`, console.warn, toast).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { OrchestrationAudit, ProviderEndpoint } from "./types.js";

// ─── Auditor prompt ────────────────────────────────────────────────

const FALLBACK_AUDITOR_PROMPT =
  `You are the acceptance auditor. Given the CTO summary and worker results,\n` +
  `verify the acceptance claim is grounded. Respond with ONLY a JSON object:\n` +
  `{"verdict": "pass" | "flag", "issues": ["..."]}.`;

function loadAuditorPrompt(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = resolve(here, "./prompts/auditor.md");
    return readFileSync(path, "utf-8").trim();
  } catch (err) {
    console.warn("[ShiftRouter] Failed to load prompts/auditor.md, using fallback:", err);
    return FALLBACK_AUDITOR_PROMPT;
  }
}

const AUDITOR_PROMPT = loadAuditorPrompt();

// ─── Transcript extraction (deterministic, pure) ───────────────────

/** Last assistant message text from an agent_end transcript (best-effort). */
export function extractFinalAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown } | undefined;
    if (!m || typeof m !== "object" || m.role !== "assistant") continue;
    if (Array.isArray(m.content)) {
      const text = m.content
        .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
        .join("\n")
        .trim();
      if (text) return text;
    } else if (typeof m.content === "string" && m.content.trim()) {
      return m.content.trim();
    }
  }
  return "";
}

/**
 * Best-effort extraction of subagent worker results from an agent_end
 * transcript. Returns one text block per tool-result message (truncated to
 * `maxCharsPerResult`), so the auditor can check acceptance grounding.
 */
export function extractWorkerResults(messages: unknown[], maxCharsPerResult = 2000): string {
  const blocks: string[] = [];
  for (const raw of messages) {
    const m = raw as { role?: string; toolCallId?: string; content?: unknown } | undefined;
    if (!m || typeof m !== "object") continue;
    const looksLikeToolResult =
      m.role === "tool" ||
      (m.role === "user" && typeof m.toolCallId === "string") ||
      (m.role === "assistant" && m.toolCallId !== undefined && Array.isArray(m.content));
    if (!looksLikeToolResult) continue;
    let text = "";
    if (Array.isArray(m.content)) {
      text = m.content
        .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
        .join("\n")
        .trim();
    } else if (typeof m.content === "string") {
      text = m.content.trim();
    }
    if (text) blocks.push(text.slice(0, maxCharsPerResult));
  }
  return blocks.join("\n\n--- worker result ---\n\n");
}

/**
 * Deterministic CTO-summary check. The orchestrator output contract ends the
 * run with "CTO summary: planned / delegated / reviewed+accepted / remains",
 * so we look for the marker token or ≥2 of its four content words.
 */
export function hasCtoSummary(text: string): boolean {
  if (!text) return false;
  if (/\bCTO summary\b/i.test(text)) return true;
  const markers = ["planned", "delegated", "reviewed", "accepted", "remains", "remaining"];
  let hits = 0;
  for (const marker of markers) {
    if (new RegExp(`\\b${marker}\\b`, "i").test(text)) hits += 1;
  }
  return hits >= 2;
}

/**
 * Run the deterministic half of the audit over a finished orchestration.
 * Pure — takes the orchestration snapshot and transcript, returns findings.
 */
export function deterministicAudit(input: {
  spawned: number;
  done: number;
  rounds: number;
  escalations: number;
  maxRounds: number;
  escalationThreshold: number;
  messages: unknown[];
}): Pick<OrchestrationAudit, "complete" | "hasCtoSummary" | "capHit" | "violations"> {
  const violations: string[] = [];
  const complete = input.spawned === 0 || input.done >= input.spawned;
  if (!complete) {
    violations.push(`worker results incomplete (done ${input.done}/${input.spawned})`);
  }
  const finalText = extractFinalAssistantText(input.messages);
  const ctoSummary = hasCtoSummary(finalText);
  if (!ctoSummary) {
    violations.push("no CTO summary in the final assistant message (acceptance not reported)");
  }
  const capHit =
    input.spawned > 0 &&
    (input.rounds >= input.maxRounds || input.escalations >= input.escalationThreshold);
  if (capHit) {
    violations.push(`ended at hard cap (rounds ${input.rounds}/${input.maxRounds}, escalations ${input.escalations}/${input.escalationThreshold})`);
  }
  return { complete, hasCtoSummary: ctoSummary, capHit, violations };
}

// ─── LLM audit (best-effort, IO injected) ──────────────────────────

/** Shape of the LLM verdict we parse from the auditor's JSON reply. */
export interface AuditorVerdict {
  verdict: "pass" | "flag";
  issues: string[];
}

/** Parse the auditor's JSON reply (tolerant). Returns null when unparseable. */
export function parseAuditorVerdict(text: string): AuditorVerdict | null {
  if (!text) return null;
  const trimmed = text.trim();
  const jsonMatch = trimmed.match(/\{[^{}]*"verdict"\s*:\s*"(pass|flag)"[^{}]*\}/i);
  if (jsonMatch) {
    const block = jsonMatch[0];
    const verdict = jsonMatch[1]!.toLowerCase() as "pass" | "flag";
    const issues: string[] = [];
    const issueMatches = block.match(/"issues"\s*:\s*\[([^\]]*)\]/i);
    if (issueMatches) {
      const items = issueMatches[1]!.match(/"((?:[^"\\]|\\.)*)"/g) ?? [];
      for (const item of items) {
        const s = item.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, " ").trim();
        if (s) issues.push(s);
      }
    }
    return { verdict, issues };
  }
  // Loose fallback: "pass" / "flag" keyword.
  if (/\bflag\b/i.test(trimmed) && !/\bpass\b/i.test(trimmed)) return { verdict: "flag", issues: [] };
  if (/\bpass\b/i.test(trimmed)) return { verdict: "pass", issues: [] };
  return null;
}

export interface AuditLLMCall {
  (
    goal: string | undefined,
    ctoSummary: string,
    workerResults: string,
    endpoints: ProviderEndpoint[],
    timeoutMs: number,
    verbose: boolean,
  ): Promise<AuditorVerdict | null>;
}

/** Real LLM audit call — one attempt on the fast tier, JSON-mode enforced. */
export const callAuditLLM: AuditLLMCall = async (
  goal,
  ctoSummary,
  workerResults,
  endpoints,
  timeoutMs,
  verbose,
) => {
  const endpoint = endpoints[0];
  if (!endpoint) return null;
  const prompt = AUDITOR_PROMPT
    .replaceAll("{{goal}}", goal?.trim() || "(not captured)")
    .replaceAll("{{ctoSummary}}", ctoSummary || "(none)")
    .replaceAll("{{workerResults}}", workerResults || "(none)");
  try {
    const base = endpoint.baseUrl.replace(/\/+$/, "");
    const url = endpoint.apiType.startsWith("anthropic")
      ? `${base}/v1/messages`
      : `${base}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    if (endpoint.apiType.startsWith("anthropic")) {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": endpoint.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: endpoint.modelId,
          max_tokens: 1000,
          system: prompt,
          messages: [
            { role: "user", content: "Audit the acceptance claim." },
            { role: "assistant", content: "{" },
          ],
        }),
        signal: controller.signal,
      });
    } else {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${endpoint.apiKey}` },
        body: JSON.stringify({
          model: endpoint.modelId,
          max_tokens: 1000,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: "Audit the acceptance claim." },
          ],
        }),
        signal: controller.signal,
      });
    }
    clearTimeout(timer);
    if (!res.ok) return null;
    const raw = (await res.json()) as Record<string, unknown>;
    let text = "";
    if (endpoint.apiType.startsWith("anthropic")) {
      const content = (raw as { content?: Array<{ text?: string }> }).content;
      if (Array.isArray(content)) text = content.map((c) => c?.text ?? "").join("");
    } else {
      const choice = (raw as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0];
      text = choice?.message?.content ?? "";
    }
    const parsed = parseAuditorVerdict(text);
    if (verbose) {
      console.log(
        `[ShiftRouter] 🧾 audit LLM ${parsed ? `verdict=${parsed.verdict} issues=${parsed.issues.length}` : "unparseable"}`,
      );
    }
    return parsed;
  } catch (err) {
    if (verbose) console.warn(`[ShiftRouter] 🧾 audit LLM call failed: ${err}`);
    return null;
  }
};

// ─── Orchestration audit runner ────────────────────────────────────

/**
 * Audit a finished orchestration run. Deterministic checks always run;
 * the LLM pass runs when `enabled` and an `llmCall` is provided. Pure-ish —
 * the LLM call is the only IO and it is injected.
 */
export async function auditOrchestration(input: {
  spawned: number;
  done: number;
  rounds: number;
  escalations: number;
  maxRounds: number;
  escalationThreshold: number;
  messages: unknown[];
  enabled: boolean;
  goal?: string;
  ctoSummary?: string;
  workerResults?: string;
  endpoints?: ProviderEndpoint[];
  timeoutMs?: number;
  verbose?: boolean;
  llmCall?: AuditLLMCall;
}): Promise<OrchestrationAudit> {
  const base = deterministicAudit(input);
  const audit: OrchestrationAudit = {
    auditedAt: Date.now(),
    ...base,
    violations: [...base.violations],
  };
  const llmEnabled = input.enabled && !!input.llmCall && input.endpoints && input.endpoints.length > 0;
  if (!llmEnabled) return audit;

  try {
    const verdict = await input.llmCall!(
      input.goal,
      input.ctoSummary ?? "",
      input.workerResults ?? "",
      input.endpoints!,
      input.timeoutMs ?? 5000,
      input.verbose ?? false,
    );
    if (verdict) {
      audit.llm = { verdict: verdict.verdict, issues: verdict.issues.slice(0, 10) };
      if (verdict.verdict === "flag" && verdict.issues.length > 0) {
        audit.violations.push(`LLM audit: ${verdict.issues.join("; ")}`);
      }
    }
  } catch (err) {
    // Errors are values: a failing audit LLM must never crash agent_end.
    audit.violations.push(`LLM audit failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return audit;
}
