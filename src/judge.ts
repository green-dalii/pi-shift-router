/**
 * pi-shift-router — Task classifier (Judge)
 *
 * Single-stage classification via LLM (uses the fast tier's model).
 * On failure: hold position (return "fast"), log a warning.
 * No heuristic rules, no regex — the LLM is the sole classifier.
 *
 * Output format: the Judge prompt asks for `{"tier":"fast"}` or `{"tier":"smart"}`.
 * Reasoning models (DeepSeek Reasoner) put their thinking in `reasoning_content` and
 * the JSON in `content`. We try JSON-parse first, then fall back to keyword search
 * in either content or reasoning_content.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { JudgeResult, Tier, ProviderEndpoint } from "./types.js";
import { detectFailoverError } from "./failover.js";

// ─── Judge system prompt ──────────────────────────────────────────

const FALLBACK_PROMPT =
  `You are a task classifier. Respond with ONLY a JSON object: ` +
  `{"tier": "fast"} or {"tier": "smart"}.`;

function loadJudgePrompt(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = resolve(here, "./prompts/judge.md");
    return readFileSync(path, "utf-8").trim();
  } catch (err) {
    console.warn("[ShiftRouter] Failed to load prompts/judge.md, using fallback:", err);
    return FALLBACK_PROMPT;
  }
}

const JUDGE_PROMPT = loadJudgePrompt();

// ─── LLM Judge ────────────────────────────────────────────────────

/**
 * Discriminated result of a single Judge model call.
 * On HTTP failure with a failover signature (429/5xx/quota), `code` carries
 * the signature so the caller can mark the model into the shared cooldown
 * map (SPEC §8.5) — preventing the same model from being retried on
 * subsequent turns / judge calls. Non-failover failures (network, timeout,
 * auth, unparseable) leave `code` null and never cool the model down.
 */
export type JudgeCallOutcome =
  | { ok: true; result: JudgeResult }
  | { ok: false; code: string | null };

/** Derive a failover signature from an HTTP error. Returns null when not failover-worthy. */
function judgeFailureCode(status: number, bodyText: string): string | null {
  // Body signature first — catches unsupported_model / rate_limit_error / quota / 限流.
  // unsupported_model is a 400 on OpenAI-compat APIs but must still trigger
  // Judge failover (try next fast chain model) and shared cooldown.
  const fromBody = detectFailoverError(bodyText);
  if (fromBody) return fromBody.code;
  // Status-based: 429 and 5xx are transient; other 4xx (400/401/403) are
  // config/auth errors and must NOT trigger cooldown — except the body
  // already handled unsupported_model above.
  if (status === 429) return "429";
  if (status >= 500 && status < 600) return String(status);
  return null;
}

function judgeApiUrl(baseUrl: string, apiType: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (apiType.startsWith("anthropic")) return `${base}/v1/messages`;
  return `${base}/chat/completions`;
}

/** Try to extract a tier answer from text (JSON or keyword). Exported for unit tests. */

/**
 * Safe JSON.stringify that returns the literal string "undefined" when
 * given `undefined` (since JSON.stringify(undefined) is `undefined`, not a
 * string — which crashes any subsequent `.slice()`).
 */
function jsonStr(v: unknown): string {
  return v === undefined ? "undefined" : JSON.stringify(v);
}

export function extractTier(text: string): Tier | null {
  if (!text) return null;
  const trimmed = text.trim();

  // 1. JSON parse: {"tier": "fast" | "smart"}
  const jsonMatch = trimmed.match(/\{[^{}]*"tier"\s*:\s*"(fast|smart)"[^{}]*\}/i);
  if (jsonMatch) return jsonMatch[1]!.toLowerCase() as Tier;

  // 2. JSON-like with single quotes or unquoted
  const looseMatch = trimmed.match(/["']?tier["']?\s*[:=]\s*["']?(fast|smart)["']?/i);
  if (looseMatch) return looseMatch[1]!.toLowerCase() as Tier;

  // 3. Bare keyword (first occurrence, word-bounded)
  const keywordMatch = trimmed.match(/\b(fast|smart)\b/i);
  if (keywordMatch) {
    const w = keywordMatch[1]!.toLowerCase();
    if (w === "fast" || w === "smart") return w as Tier;
  }

  return null;
}

async function classifyLLM(
  prompt: string,
  endpoint: ProviderEndpoint,
  signal: AbortSignal | undefined,
  verbose: boolean,
): Promise<JudgeCallOutcome> {
  try {
    const body = buildRequestBody(endpoint, prompt);
    const url = judgeApiUrl(endpoint.baseUrl, endpoint.apiType);

    if (verbose) {
      console.log(`[ShiftRouter] Judge → ${endpoint.modelId} (${endpoint.apiType})`);
      console.log(`[ShiftRouter] Judge URL: ${url}`);
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(endpoint.apiType.startsWith("anthropic")
          ? { "x-api-key": endpoint.apiKey, "anthropic-version": "2023-06-01" }
          : { Authorization: `Bearer ${endpoint.apiKey}` }),
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (verbose) {
        console.warn(`[ShiftRouter] Judge API error ${res.status} from ${url}: ${text.slice(0, 200)}`);
      }
      return { ok: false, code: judgeFailureCode(res.status, text) };
    }

    const raw = await res.json();

    const answer = parseResponse(raw, endpoint.apiType);
    if (!answer) {
      const choice = (raw as any).choices?.[0];
      const content = jsonStr(choice?.message?.content);
      const reasoning = jsonStr(choice?.message?.reasoning_content);
      const finish = choice?.finish_reason ?? "?";
      if (verbose) {
        console.warn(
          `[ShiftRouter] Judge unparseable from ${url}: ` +
          `content=${content.slice(0, 100)}, reasoning=${reasoning.slice(0, 100)}, finish=${finish}`,
        );
      }
      // 200-but-unparseable: model is responding, just not with valid JSON.
      // Do NOT cool it down — that would block real turns on the model too.
      return { ok: false, code: null };
    }
    const result: JudgeResult = {
      tier: answer.tier,
      source: "llm",
      ...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}),
      ...(answer.reason !== undefined ? { reason: answer.reason } : {}),
    };
    return { ok: true, result };
  } catch (err) {
    // Network / abort / DNS failure — not a failover signature, do not cool down.
    if (verbose) {
      console.warn(`[ShiftRouter] Judge fetch failed for ${endpoint.baseUrl}: ${err}`);
    }
    return { ok: false, code: null };
  }
}

function buildRequestBody(endpoint: ProviderEndpoint, prompt: string): Record<string, unknown> {
  // Budget enough tokens for reasoning + JSON answer.
  // DeepSeek Reasoner-class models emit `reasoning_content` and the JSON answer in `content`;
  // both are bounded by `max_tokens`. 4000 leaves plenty of room for the chain-of-thought.
  const maxTokens = 4000;

  if (endpoint.apiType.startsWith("anthropic")) {
    // Anthropic has no native JSON mode. Use assistant prefill (`{`) to force JSON-start output.
    return {
      model: endpoint.modelId,
      max_tokens: maxTokens,
      system: JUDGE_PROMPT,
      messages: [
        { role: "user", content: prompt },
        { role: "assistant", content: "{" },
      ],
    };
  }

  // OpenAI-compatible (DeepSeek, OpenAI, etc.): force JSON output via response_format.
  // This is a hard constraint — the API rejects non-JSON completions.
  return {
    model: endpoint.modelId,
    max_tokens: maxTokens,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: JUDGE_PROMPT },
      { role: "user", content: prompt }],
  };
}

/** Result of parsing a Judge response: tier + optional confidence (0-1). */
export interface ParsedJudgeResponse {
  tier: Tier;
  confidence?: number;
  /** Ultra-short classification reason (one phrase); absent when not emitted. */
  reason?: string;
  /** Explicit orchestration signal (true/false); absent when not emitted. */
  orchestrate?: boolean;
}

function parseResponse(raw: Record<string, unknown>, apiType: string): ParsedJudgeResponse | null {
  try {
    let contentText = "";
    let reasoningText = "";

    if (apiType.startsWith("anthropic")) {
      const content = (raw as any).content;
      if (Array.isArray(content)) contentText = content.map((c: any) => c?.text ?? "").join("");
    } else {
      const choice = (raw as any).choices?.[0];
      const msg = choice?.message ?? {};
      contentText = msg.content ?? "";
      reasoningText = msg.reasoning_content ?? "";
    }

    // Try content first, then reasoning. Each can yield {tier, confidence}.
    const fromContent = parseJudgeAnswer(contentText);
    if (fromContent) return fromContent;
    return parseJudgeAnswer(reasoningText);
  } catch {
    return null;
  }
}

/** Parse a Judge answer string (JSON or loose) for tier + confidence + reason. */
export function parseJudgeAnswer(text: string): ParsedJudgeResponse | null {
  const tier = extractTier(text);
  if (!tier) return null;
  const confidence = parseConfidenceFromText(text);
  const reason = parseReasonFromText(text);
  const orchestrate = parseOrchestrateFromText(text);
  const out: ParsedJudgeResponse = { tier };
  if (confidence !== undefined) out.confidence = confidence;
  if (reason !== undefined) out.reason = reason;
  if (orchestrate !== undefined) out.orchestrate = orchestrate;
  return out;
}

/**
 * Extract the Judge's explicit orchestration signal from its answer string.
 * Accepts a JSON `orchestrate: true/false` field (or loose `orchestrate=`).
 * Returns undefined when absent or unparseable (older prompt / model chose
 * not to emit) — the caller decides the fallback.
 */
function parseOrchestrateFromText(text: string): boolean | undefined {
  const jsonMatch = text.match(/"\s*orchestrate\s*"\s*:\s*(true|false)/i);
  if (jsonMatch) return jsonMatch[1]!.toLowerCase() === "true";
  const looseMatch = text.match(/["']?orchestrate["']?\s*[:=]\s*(true|false)/i);
  if (looseMatch) return looseMatch[1]!.toLowerCase() === "true";
  return undefined;
}

/**
 * Extract the short classification reason from a Judge answer string.
 * Picks the JSON `reason`/`why` field value if present (a quoted string);
 * returns undefined when absent or unparseable. The routing algorithm never
 * reads this — it exists for verbose logs and `/router status` detail.
 */
function parseReasonFromText(text: string): string | undefined {
  // Match the `reason`/`why` field anywhere in the JSON object
  // (tier/confidence may appear before or after it).
  const jsonMatch = text.match(/"\s*(?:reason|why)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (jsonMatch) {
    const s = jsonMatch[1]!.replace(/\\n/g, " ").replace(/\\"/g, "\"").trim();
    return s.length > 0 ? s.slice(0, 120) : undefined;
  }
  return undefined;
}

/** Extract confidence (0-1) from a Judge answer string. Returns undefined when absent/invalid. */
function parseConfidenceFromText(text: string): number | undefined {
  // Try JSON first: {"tier":"fast","confidence":0.85}
  const jsonMatch = text.match(/\{[\s\S]*"confidence"\s*:\s*([0-9]*\.?[0-9]+)[\s\S]*\}/);
  if (jsonMatch) {
    const n = Number(jsonMatch[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
    return undefined;
  }
  // Loose: confidence: 0.85 or confidence=0.85
  const looseMatch = text.match(/["']?confidence["']?\s*[:=]\s*([0-9]*\.?[0-9]+)/i);
  if (looseMatch) {
    const n = Number(looseMatch[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  }
  return undefined;
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Unified task classifier with fast-tier fallback.
 *
 * `endpoints` is the fast tier's model list (priority order). The Judge
 * walks it: each failed call (429/5xx/network/timeout/unparseable) tries
 * the next model. `isCooldown` (if provided) skips models in cooldown.
 * `onFailure` (if provided) is invoked with a failover signature code
 * (429/5xx) on each failed model, so the caller can mark it into the
 * shared `modelCooldowns` map (SPEC §8.5). Without this hook, the Judge
 * would re-hit a rate-limited model on every turn — because nothing
 * remembers "A just429'd the Judge" until a full turn failure triggers
 * `agent_end`. Network errors, timeouts, and unparseable responses do
 * NOT call `onFailure` — they are not failover signatures.
 *
 * Only when ALL fast-tier models fail do we hold position (fallback).
 */
export async function classify(
  prompt: string,
  endpoints: ProviderEndpoint[] | null | undefined,
  timeout = 5000,
  verbose = false,
  isCooldown?: (provider: string, model: string) => boolean,
  onFailure?: (provider: string, model: string, code: string) => void,
): Promise<JudgeResult> {
  const list = endpoints ?? [];

  for (const endpoint of list) {
    if (isCooldown?.(endpoint.provider, endpoint.modelId)) continue;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const outcome = await classifyLLM(prompt, endpoint, controller.signal, verbose);
    clearTimeout(timer);

    if (outcome.ok) return outcome.result;
    // Failover-worthy failure (429/5xx/quota) → let caller cool the model.
    // Other failures (network/timeout/unparseable) intentionally skipped.
    if (outcome.code && onFailure) {
      onFailure(endpoint.provider, endpoint.modelId, outcome.code);
    }
  }

  if (verbose) {
    console.warn("[ShiftRouter] Judge LLM unavailable — holding position on current tier");
  }
  return { tier: "fast", source: "fallback" };
}