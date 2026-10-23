/**
 * Decision judges through pi's classifier layer (issue #54).
 *
 * pi-ai models decision endpoints natively (`typesafe-system-one`,
 * `cloudflare-workers-ai-system-one`, `openai-decisions`, `llama-cpp-classify`)
 * and `ModelRegistry.classify()` resolves auth, applies identity/attribution
 * headers, retries and prices the call. This module is the seam between that
 * contract and the router's verdict: it builds the two questions, maps the
 * answers back, and decides which refs are classifiers at all.
 *
 * Nothing here performs IO. The transport-failure semantics (hold, never
 * fabricate) live in `mapClassifierResult`, which returns null for every
 * answer shape that is not a usable verdict.
 */
import type {
  ProviderEndpoint,
  RegistryClassifierResultLike,
  RegistryModelLike,
  StoredModel,
  Tier,
} from "./types.js";
import { detectFailoverError } from "./failover.js";

/** The router's two questions. Named constants keep the request and the parse in sync. */
export const TIER_QUESTION = "tier";
export const ORCHESTRATE_QUESTION = "orchestrate";

/** Fixed orchestration criteria (the tier rubric comes from prompts/judge.md). */
export const ORCHESTRATE_INSTRUCTIONS =
  "This turn should be orchestrated (a Smart main agent planning phases and delegating " +
  "to Fast workers) rather than handled inline by a single agent.";

/** Criterion text for the tier question — the same split the LLM judge is given. */
export const TIER_CRITERIA = {
  fast: "Routine, well-specified work: execution, small fixes, following existing patterns.",
  smart: "Complex, ambiguous, high-stakes, cross-cutting, or architecture-level work.",
} as const;

export const ORCHESTRATE_CRITERIA = {
  true: "Multi-phase work that benefits from delegation to workers.",
  false: "Single-agent work; inline execution is appropriate.",
} as const;

/** The shape pi's `ClassifierContext` expects, narrowed to what the router sends. */
export interface ClassifierContextLike {
  state: { prompt: string };
  questions: {
    tier: { type: "choice"; instructions: string; criteria: Record<string, string> };
    orchestrate: { type: "bool"; instructions: string; criteria: { true: string; false: string } };
  };
}

/** Verdict extracted from a classifier result — mirrors the decision-network parse. */
export interface DecisionVerdict {
  tier: Tier;
  confidence?: number;
  orchestrate?: boolean;
}

/** A registry that can enumerate and run classifiers (pi ≥ 1.4.0). */
export interface ClassifierCapableRegistry {
  getModelsOfType?: (type: string, provider?: string) => readonly RegistryModelLike[];
  classify?: (model: RegistryModelLike, context: unknown, options?: unknown) => Promise<RegistryClassifierResultLike>;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function buildClassifierContext(prompt: string, rubric: string): ClassifierContextLike {
  return {
    state: { prompt },
    questions: {
      [TIER_QUESTION]: {
        type: "choice",
        instructions: rubric,
        criteria: { ...TIER_CRITERIA },
      },
      [ORCHESTRATE_QUESTION]: {
        type: "bool",
        instructions: ORCHESTRATE_INSTRUCTIONS,
        criteria: { ...ORCHESTRATE_CRITERIA },
      },
    },
  };
}

/**
 * Map a `ClassifierResult` onto the router's verdict.
 *
 * Null means "hold": the transport failed, a refusal came back, the chosen
 * option is not one of the two we asked about, or the probability map exists
 * but carries no usable number for it. A decision model must never be guessed
 * at — the same rule the System One parser follows (SPEC §8.6).
 */
export function mapClassifierResult(raw: RegistryClassifierResultLike | null | undefined): DecisionVerdict | null {
  try {
    if (!raw || raw.stopReason !== "stop") return null;
    const answers = raw.answers;
    if (!answers || typeof answers !== "object") return null;

    const tierAnswer = (answers as Record<string, any>)[TIER_QUESTION];
    if (!tierAnswer || typeof tierAnswer !== "object") return null;
    if (tierAnswer.type === "refusal") return null;

    const choice = typeof tierAnswer.choice === "string" ? tierAnswer.choice.toLowerCase() : null;
    if (choice !== "fast" && choice !== "smart") return null;

    const hasMap = tierAnswer.probabilities && typeof tierAnswer.probabilities === "object";
    let confidence: number | undefined;
    if (hasMap) {
      const p = tierAnswer.probabilities[choice];
      // A probability map that omits (or malforms) the chosen option is a
      // malformed answer, not a low-confidence one.
      if (!finite(p)) return null;
      confidence = p;
    } else if (finite(tierAnswer.confidence)) {
      confidence = tierAnswer.confidence;
    }

    const boolAnswer = (answers as Record<string, any>)[ORCHESTRATE_QUESTION];
    const rawBool = typeof boolAnswer === "number" ? boolAnswer : boolAnswer?.probability;
    const orchestrate = finite(rawBool) ? rawBool >= 0.5 : undefined;

    return {
      tier: choice as Tier,
      ...(confidence !== undefined ? { confidence } : {}),
      ...(orchestrate !== undefined ? { orchestrate } : {}),
    };
  } catch {
    return null;
  }
}

/** Enumerate classifier models without any IO — `getModelsOfType` is a snapshot read. */
export function listClassifierModels(registry: ClassifierCapableRegistry | undefined): RegistryModelLike[] {
  try {
    return [...(registry?.getModelsOfType?.("classifier") ?? [])];
  } catch {
    return [];
  }
}

/** Resolve one `provider/model` ref against pi's classifier catalog. */
export function findClassifierModel(
  registry: ClassifierCapableRegistry | undefined,
  provider: string,
  modelId: string,
): RegistryModelLike | null {
  return listClassifierModels(registry).find((m) => m.provider === provider && m.id === modelId) ?? null;
}

/**
 * Timeout floors, measured rather than assumed.
 *
 * System One: 1.4–6.6 s against `api.typesafe.ai` (2026-09-18), so the
 * LLM-judge default of 5 s would abort most decision calls.
 * OpenAI Decisions: documented as ~10× faster than the Responses API, and
 * hundreds of milliseconds in external benchmarks — an 8 s floor leaves room
 * without waiting on a dead endpoint for 15 s.
 */
export const SYSTEM_ONE_TIMEOUT_FLOOR_MS = 15_000;
export const OPENAI_DECISIONS_TIMEOUT_FLOOR_MS = 8_000;

export function classifierTimeoutFloor(api: string | undefined): number {
  return api === "openai-decisions" ? OPENAI_DECISIONS_TIMEOUT_FLOOR_MS : SYSTEM_ONE_TIMEOUT_FLOOR_MS;
}

export function decisionTimeoutFor(api: string | undefined, configured: number): number {
  return Math.max(configured, classifierTimeoutFloor(api));
}

/**
 * Failover signatures from a classifier error, which arrives as text. Two
 * shapes reach us: pi's OpenAI adapter says `"… returned 429"`, while the
 * System One adapter wraps the body as `"… error (402): {…}"`. Reuse the shared
 * signature detector first (it covers quota/usage/balance wording and 402),
 * then fall back to the status in the message. Only failover signatures cool an
 * endpoint down — the same policy the HTTP path applies (SPEC §8.5); anything
 * else is transient or malformed and must not block the model for real turns.
 */
export function statusFromClassifierError(message: string | undefined): string | null {
  const text = message ?? "";
  const signature = detectFailoverError(text);
  if (signature) return signature.code;
  const match = /(?:returned|error\s*\()\s*(\d{3})/.exec(text);
  if (!match) return null;
  const status = Number(match[1]);
  return status === 429 || (status >= 500 && status < 600) ? String(status) : null;
}

/**
 * The wizard's decision-model list: pi's classifier catalog first, then any
 * `models.json` endpoint still marked `typesafe-decisions` (deprecated).
 *
 * A model present in both is shown once, as the native entry — the native path
 * is the one that will keep working. Listing comes from a synchronous catalog
 * read: the wizard must not probe auth or network here (issue #52).
 */
export function listDecisionChoices(
  registry: ClassifierCapableRegistry | undefined,
  legacyModels: readonly StoredModel[],
): StoredModel[] {
  const key = (provider: string, id: string) => `${provider}/${id}`;
  const native: StoredModel[] = listClassifierModels(registry).map((m) => ({
    id: m.id,
    provider: m.provider,
    api: m.api,
    baseUrl: m.baseUrl,
    contextWindow: m.contextWindow,
    cost: m.cost
      ? { input: m.cost.input ?? 0, output: m.cost.output ?? 0, cacheRead: m.cost.cacheRead, cacheWrite: m.cost.cacheWrite }
      : undefined,
    name: `${m.name ?? m.id} (pi)`,
  }));

  const seen = new Set(native.map((m) => key(m.provider, m.id)));
  const legacy = legacyModels
    .filter((m) => m.api === "typesafe-decisions")
    .filter((m) => !seen.has(key(m.provider, m.id)))
    .map((m) => ({ ...m, name: `${m.name ?? m.id} (legacy endpoint — deprecated)` }));

  return [...native, ...legacy];
}

/**
 * pi's System One transport builds `${baseUrl}/systemone`. For the official
 * TypeSafe host that is wrong: the API serves `/v1/systemone`, and pi 1.4.0
 * flattens the catalog's `https://api.typesafe.ai/v1/` down to the provider
 * root, so the native call 404s (verified live 2026-10-23: `/systemone` → 404,
 * `/v1/systemone` → 403 without a key, i.e. the path exists).
 *
 * Gateways are unaffected — OpenRouter (`…/api/v1`) and Vercel (`…/typesafe/v1`)
 * already end in `/v1`, and a host that later fixes its catalog stops matching
 * this exact string. Remove this once pi ships the corrected baseUrl.
 */
const TYPESAFE_OFFICIAL_BASE = "https://api.typesafe.ai";

export function normalizeClassifierModel(model: RegistryModelLike): RegistryModelLike {
  const base = (model.baseUrl ?? "").replace(/\/+$/, "");
  if (model.api === "typesafe-system-one" && base === TYPESAFE_OFFICIAL_BASE) {
    return { ...model, baseUrl: `${base}/v1` };
  }
  return model;
}

/**
 * Build a `ProviderEndpoint` from a classifier model. `apiKey` stays empty:
 * pi resolves credentials inside `classify()`, so the router never handles the
 * key for this path.
 */
export function classifierEndpoint(provider: string, model: RegistryModelLike): ProviderEndpoint {
  return {
    provider,
    baseUrl: (model.baseUrl ?? "").replace(/\/+$/, ""),
    apiType: model.api ?? "typesafe-system-one",
    apiKey: "",
    modelId: model.id,
    classifier: model,
  };
}
