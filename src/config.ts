/**
 * pi-shift-router — Configuration loader
 *
 * Reads pi-agent's models-store.json (built-in catalog), models.json (custom providers),
 * and auth.json, resolves Judge endpoint,
 * and manages the pi-shift-router.json config file (user-level + project-level).
 */

import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { appendRouterLog } from "./log.js";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import {
  type ShiftRouterConfig,
  type JudgeMode,
  type ModelRegistryLike,
  type ModelsStore,
  type AuthStore,
  type ProviderEntry,
  type StoredModel,
  type ProviderEndpoint,
  DEFAULT_CONFIG,
  TIERS,
} from "./types.js";

const PI_AGENT_DIR = join(homedir(), ".pi", "agent");

/** pi's per-agent state dir (`~/.pi/agent`) — single source for path rules. */
export function piAgentDir(): string {
  return PI_AGENT_DIR;
}
const CONFIG_FILENAME = "pi-shift-router.json";

let _config: ShiftRouterConfig | null = null;
let _modelsStore: ModelsStore | null = null;
let _authStore: AuthStore | null = null;
let _configPath: string | null = null;

/** Default paths for pi-agent's model catalog. Overridable for testing. */
export const DEFAULT_MODELS_PATHS = {
  builtin: join(PI_AGENT_DIR, "models-store.json"),
  custom: join(PI_AGENT_DIR, "models.json"),
};

// ─── Paths ────────────────────────────────────────────────────────

/** User-level config: ~/.pi/agent/pi-shift-router.json (personal preferences) */
export function userConfigPath(): string {
  return join(PI_AGENT_DIR, CONFIG_FILENAME);
}

/** Project-level config: <cwd>/.pi/pi-shift-router.json (team-shared, git-tracked) */
export function projectConfigPath(cwd: string): string {
  return resolve(cwd, ".pi", CONFIG_FILENAME);
}

/** Active config path. Project takes precedence. */
export function getConfigPath(): string | null {
  return _configPath;
}

/** Which config layer is authoritative for the loaded config. */
export type ConfigSource = "project" | "user" | "default";

let _configSource: ConfigSource = "default";
let _userLayerExists = false;
let _projectLayerExists = false;

/**
 * Source of the LAST LOADED config (set by loadConfig, reset by
 * invalidateConfigCache). "project" = project file exists and wins;
 * "user" = only the user layer exists; "default" = neither file exists.
 * The user layer is always merged underneath when present — project wins
 * on CONFLICT, it does not replace the user file wholesale.
 */
export function getConfigSource(): {
  source: ConfigSource;
  path: string | null;
  userLayerExists: boolean;
  projectExists: boolean;
} {
  return {
    source: _configSource,
    path: _configPath,
    userLayerExists: _userLayerExists,
    projectExists: _projectLayerExists,
  };
}

/** Check if a file exists */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// ─── Pi-agent shared stores ───────────────────────────────────────

const ENV_LITERALS: Record<string, string> = { "$$": "$", "$!": "!" };

/**
 * Expand `$VAR` / `${VAR}` / `$$` / `$!` (pi models.json escape rules).
 *
 * Variable names must start with a letter or underscore (POSIX env-var
 * convention). Patterns like `$1` or `$5` (digit-prefixed) are preserved
 * literally, avoiding silent API-key truncation for any value that happens
 * to contain such patterns.
 *
 * Note: letter-prefixed `$VAR` patterns (e.g., `"key$REAL"`) are still
 * consumed and expanded if the env defines `VAR`. Users who want a literal
 * `$VAR` substring inside an apiKey should use the `$$` escape (e.g.,
 * `"key$$VAR"` → `"key$VAR"`).
 *
 * Shell commands (`!cmd`) are resolved by pi at request time — unsupported here, so the value
 * stays unresolvable and the provider falls back to auth.json or is skipped.
 */
export function expandEnv(value: string | undefined, env: Record<string, string | undefined> = process.env): string | undefined {
  if (value === undefined) return undefined;
  if (value.startsWith("!")) return undefined;
  const expanded = value.replace(/\$\$|\$!|\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (m, braced, plain) =>
    ENV_LITERALS[m] ?? (env[braced ?? plain ?? ""] ?? ""),
  );
  return expanded || undefined;
}

/**
 * Merge custom providers (models.json `{ providers: { name: {...} } }` shape) over the
 * built-in catalog. Provider fields merge per key; custom models are upserted by `id`
 * (pi semantics: built-in models kept, same-id custom model replaces).
 */
export function mergeCustomProviders(builtin: ModelsStore, custom: { providers?: Record<string, ProviderEntry> }): ModelsStore {
  const store: ModelsStore = { ...builtin };
  for (const [provider, entry] of Object.entries(custom.providers ?? {})) {
    if (!entry || typeof entry !== "object") continue;
    const { models, ...providerFields } = entry;
    const base = store[provider] ?? { models: [] as StoredModel[] };
    const merged: ProviderEntry = { ...base, ...providerFields };
    if (Array.isArray(models)) {
      const byId = new Map(merged.models.map((m) => [m.id, m]));
      for (const m of models) if (m && typeof m.id === "string") byId.set(m.id, m);
      merged.models = [...byId.values()];
    }
    store[provider] = merged;
  }
  return store;
}

/**
 * Load models-store.json (built-in catalog), merged with custom providers from models.json.
 * Accepts optional path overrides for testing; production callers omit these.
 */
export async function loadModelsStore(
  paths: { builtin?: string; custom?: string } = {},
): Promise<ModelsStore> {
  if (_modelsStore) return _modelsStore;
  const builtinPath = paths.builtin ?? DEFAULT_MODELS_PATHS.builtin;
  const customPath = paths.custom ?? DEFAULT_MODELS_PATHS.custom;
  let builtin: ModelsStore = {};
  try {
    builtin = JSON.parse(await readFile(builtinPath, "utf-8")) as ModelsStore;
  } catch {
    // missing/malformed built-in catalog is not fatal
  }
  let custom: { providers?: Record<string, ProviderEntry> } = {};
  try {
    custom = JSON.parse(await readFile(customPath, "utf-8")) as { providers?: Record<string, ProviderEntry> };
  } catch {
    // missing custom models file is fine
  }
  _modelsStore = mergeCustomProviders(builtin, custom);
  return _modelsStore;
}

/** Load auth.json */
export async function loadAuthStore(): Promise<AuthStore> {
  if (_authStore) return _authStore;
  const authPath = join(PI_AGENT_DIR, "auth.json");
  try {
    const raw = await readFile(authPath, "utf-8");
    _authStore = JSON.parse(raw) as AuthStore;
    return _authStore;
  } catch {
    return {};
  }
}

/** Get all models from the store as a flat array. Used by the config wizard. */
export function flattenModels(store: ModelsStore): StoredModel[] {
  const models: StoredModel[] = [];
  for (const [provider, entry] of Object.entries(store)) {
    for (const model of entry.models) {
      models.push({ ...model, provider });
    }
  }
  return models;
}

/**
 * Look up pricing (USD per 1M tokens) for a model. Returns null when the
 * model is unknown or pricing is missing. Used by the cost-telemetry
 * hypothetical-baseline calculation (SPEC §9 “Cost telemetry — deep view”).
 */
export function getModelPricing(
  store: ModelsStore,
  provider: string,
  modelId: string,
): { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null {
  const provEntry = store[provider];
  if (!provEntry) return null;
  const model = provEntry.models.find((m) => m.id === modelId);
  if (!model?.cost) return null;
  return {
    input: model.cost.input,
    output: model.cost.output,
    cacheRead: model.cost.cacheRead,
    cacheWrite: model.cost.cacheWrite,
  };
}

/** Invalidate all caches. Call after config edit. */
export function invalidateConfigCache(): void {
  _config = null;
  _configPath = null;
  _configSource = "default";
  _userLayerExists = false;
  _projectLayerExists = false;
  // Also clear the models-store cache: a config save is a "something changed"
  // signal — the user may also have edited models.json, and the next read should
  // reflect current disk state. _authStore is intentionally NOT cleared (owned by pi-agent).
  _modelsStore = null;
}

/**
 * Invalidate the merged models-store cache. Call before any user-facing picker
 * (e.g., `/router config`) so the wizard shows the current state of
 * `models-store.json` and `models.json` from disk, not a stale startup snapshot.
 * `_authStore` is owned by pi-agent and is not cleared here — call
 * `invalidateAuthStoreCache()` separately when you also need fresh credentials.
 */
export function invalidateModelsStoreCache(): void {
  _modelsStore = null;
}

/** Invalidate the auth.json cache so the next `loadAuthStore()` re-reads from disk. */
export function invalidateAuthStoreCache(): void {
  _authStore = null;
}

/**
 * Whether `provider` currently has valid credentials.
 * True if auth.json has any credential for the provider, or its catalog entry
 * carries an inline `apiKey` that expands to a real value (e.g. `$ENV_VAR`).
 */
export function isProviderAuthenticated(
  provider: string,
  auth: AuthStore,
  store: ModelsStore,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (auth[provider]) return true;
  const entry = store[provider];
  if (!entry) return false;
  return !!expandEnv(entry.apiKey, env);
}

/**
 * Whether a configured `provider/model` is unavailable — i.e. not present
 * in the catalog or its provider lacks valid auth. Pure helper for the
 * tier-editor's "(unavailable)" badge; exported for testing.
 */
export function isModelUnavailable(
  provider: string,
  model: string,
  store: ModelsStore,
  auth: AuthStore,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!isProviderAuthenticated(provider, auth, store, env)) return true;
  const entry = store[provider];
  if (!entry) return true;
  return !entry.models.some((m) => m.id === model);
}

// ─── Fast endpoint resolution ────────────────────────────────────

/**
 * Resolve endpoint info for the LLM Judge — the ENTIRE fast tier chain
 * (priority order), so the Judge can fall back to the next fast model when
 * one fails (SPEC §8.5 / runtime failover parity).
 *
 * Order:
 *   1. fast tier's models in priority order (each with valid auth)
 *   2. cheapest model with valid auth (global fallback)
 */
/**
 * Resolve ONE `provider/model` into an endpoint: registry first (pi owns the
 * catalog and credentials), store + auth.json as the fallback (SPEC §5.4).
 */
async function resolveEndpoint(
  provider: string,
  modelId: string,
  store: ModelsStore,
  auth: AuthStore,
  env: Record<string, string | undefined>,
  registry?: ModelRegistryLike,
): Promise<ProviderEndpoint | null> {
  {
    // Registry first: pi owns the catalog and the credential resolution, so a
    // model authenticated via env vars / models.json command / runtime login is
    // a valid Judge endpoint even when it is absent from models-store.json.
    const registryModel = registry?.find?.(provider, modelId);
    if (registryModel) {
      const apiKey =
        (await registry?.getApiKeyForProvider?.(provider)) ??
        auth[provider]?.key ??
        expandEnv(store[provider]?.apiKey, env);
      if (!apiKey) return null;
      return {
        provider,
        baseUrl: (registryModel.baseUrl ?? store[provider]?.baseUrl ?? "").replace(/\/+$/, ""),
        apiType: registryModel.api ?? store[provider]?.api ?? "openai-completions",
        apiKey,
        modelId,
      };
    }
    const provEntry = store[provider];
    if (!provEntry) return null;
    const modelInfo = provEntry.models.find((m) => m.id === modelId);
    if (!modelInfo) return null;
    // auth.json (raw key, verbatim) first, then provider-level inline apiKey from models.json (env-var expandable).
    const apiKey = auth[provider]?.key ?? expandEnv(provEntry.apiKey, env);
    if (!apiKey) return null;
    return {
      provider,
      baseUrl: (modelInfo.baseUrl ?? provEntry.baseUrl ?? "").replace(/\/+$/, ""),
      apiType: modelInfo.api ?? provEntry.api ?? "openai-completions",
      apiKey,
      modelId,
    };
  }
}

export async function resolveFastEndpoints(
  config: ShiftRouterConfig,
  storeOverride?: ModelsStore,
  authOverride?: AuthStore,
  env: Record<string, string | undefined> = process.env,
  registry?: ModelRegistryLike,
): Promise<ProviderEndpoint[]> {
  const store = storeOverride ?? (await loadModelsStore());
  const auth = authOverride ?? (await loadAuthStore());
  const resolve = (provider: string, modelId: string) =>
    resolveEndpoint(provider, modelId, store, auth, env, registry);

  const endpoints: ProviderEndpoint[] = [];

  // 1. Fast tier chain, in priority order.
  const fastModels = [...(config.tiers.fast.models ?? [])].sort((a, b) => a.priority - b.priority);
  for (const ref of fastModels) {
    const ep = await resolve(ref.provider, ref.model);
    if (ep) endpoints.push(ep);
  }
  if (endpoints.length > 0) {
    // Verbose-gated: this fires on every /router config save / on-off toggle
    // via onConfigChanged — unconditional logging was user-visible noise.
    if (config?.ux?.routerLogVerbose) {
      appendRouterLog(`[ShiftRouter] Judge endpoints: ${endpoints.map((e) => `${e.provider}/${e.modelId}`).join(", ")}`);
    }
    return endpoints;
  }

  // 2. Fallback: cheapest model with auth.
  const candidates: Array<{ provider: string; modelId: string; cost: number }> = [];
  const registryAvailable = registry?.getAvailable?.();
  if (registryAvailable) {
    for (const m of registryAvailable) {
      const cost = m.cost?.input ?? Number.MAX_SAFE_INTEGER;
      candidates.push({ provider: m.provider, modelId: m.id, cost });
    }
  } else {
    for (const [prov, entry] of Object.entries(store)) {
      if (!(auth[prov]?.key ?? expandEnv(entry.apiKey, env))) continue;
      for (const m of entry.models) {
        const cost = m.cost?.input ?? Number.MAX_SAFE_INTEGER;
        if (cost >= 0) candidates.push({ provider: prov, modelId: m.id, cost });
      }
    }
  }
  candidates.sort((a, b) => a.cost - b.cost);
  if (candidates.length === 0) {
    if (config?.ux?.routerLogVerbose) {
      appendRouterLog("[ShiftRouter] Judge: no provider with valid API key found — cannot resolve judge endpoint");
    }
    return [];
  }
  const cheapest = candidates[0];
  const ep = await resolve(cheapest.provider, cheapest.modelId);
  if (ep) {
    if (config?.ux?.routerLogVerbose) {
      appendRouterLog(`[ShiftRouter] Judge: fast tier unavailable, falling back to cheapest: ${cheapest.provider}/${cheapest.modelId}`);
    }
    return [ep];
  }
  return [];
}

// ─── Config persistence ────────────────────────────────────────────

/**
 * Save config to a specific path (user or project).
 * @param scope "user" → ~/.pi/agent/, "project" → <cwd>/.pi/
 */
export async function saveConfig(
  config: ShiftRouterConfig,
  cwd: string,
  scope: "user" | "project" = "project",
): Promise<boolean> {
  const configPath = scope === "user" ? userConfigPath() : projectConfigPath(cwd);
  try {
    const dir = dirname(configPath);
    await mkdir(dir, { recursive: true });
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
    invalidateConfigCache();
    _configPath = configPath;
    return true;
  } catch (err) {
    console.warn(`[ShiftRouter] Failed to save config: ${err}`);
    return false;
  }
}

/**
 * Judge chain resolution (SPEC §8.6). `fast-chain` mode delegates to
 * `resolveFastEndpoints` (byte-identical legacy behaviour, including the
 * cheapest-authenticated fallback). `custom` / `decision` modes resolve ONLY
 * `routing.judge.models` in priority order — no cheap-model fallback: an
 * unresolvable dedicated chain holds position rather than judging on a model
 * the user did not choose.
 */
/**
 * Resolve the effective judge mode from whatever shape the config is in
 * (SPEC §8.6 migration contract):
 *
 * - `fast-chain` / `custom` / `decision` → honoured as-is.
 * - **models present, no mode** → `custom`. This is the migration case: a config
 *   written against an earlier shape expressed "use these models to judge" with
 *   no mode key, and the merged default (`fast-chain`) would silently ignore the
 *   list. Inferring `custom` is the only reading that does not discard the
 *   user's intent; the resolver logs the inference.
 * - absent / unknown → `fast-chain`, i.e. pre-v1.7.0 behaviour. An unknown value
 *   (typo, hand-edit) must never brick routing: it degrades to what every old
 *   config already did.
 */
export function normalizeJudgeMode(judge?: { mode?: string; models?: { provider: string; model: string }[] }): JudgeMode {
  const raw = judge?.mode;
  if (raw === "fast-chain" || raw === "custom" || raw === "decision") return raw;
  if (raw === undefined && (judge?.models?.length ?? 0) > 0) return "custom";
  return "fast-chain";
}

export async function resolveJudgeEndpoints(
  config: ShiftRouterConfig,
  storeOverride?: ModelsStore,
  authOverride?: AuthStore,
  env: Record<string, string | undefined> = process.env,
  registry?: ModelRegistryLike,
): Promise<ProviderEndpoint[]> {
  const rawMode = config.routing.judge?.mode;
  const mode = normalizeJudgeMode(config.routing.judge);
  if (rawMode !== undefined && rawMode !== mode) {
    appendRouterLog(`[ShiftRouter] Judge mode "${rawMode}" is not recognised — using ${mode}`);
  } else if (rawMode === undefined && mode === "custom") {
    appendRouterLog("[ShiftRouter] Judge: judge.models present without a mode — migrated to custom");
  }
  if (mode === "fast-chain") return resolveFastEndpoints(config, storeOverride, authOverride, env, registry);

  const store = storeOverride ?? (await loadModelsStore());
  const auth = authOverride ?? (await loadAuthStore());
  const primary: ProviderEndpoint[] = [];
  const models = [...(config.routing.judge?.models ?? [])].sort((a, b) => a.priority - b.priority);
  for (const ref of models) {
    const ep = await resolveEndpoint(ref.provider, ref.model, store, auth, env, registry);
    if (ep) primary.push(ep);
  }

  // The judge ladder (SPEC §8.6), expressed as one ordered list so a single
  // `classify()` walk covers BOTH failure kinds in the same turn:
  //   1. the chain the user configured for judging (decision model, or a
  //      dedicated LLM chain);
  //   2. the LLM judge — their own Fast chain, i.e. the pre-v1.7.0 default.
  // Rung 1 can fail two ways: it may not resolve at all (retired model, removed
  // key, gone provider), or its endpoints may fail *at call time* (429, 5xx,
  // timeout, cooldown). Concatenating means the walk continues into rung 2 for
  // both, instead of holding the turn on a transient error. If rung 2 is also
  // exhausted there is no verdict at all, and the caller stops routing rather
  // than guessing (one notice per session).
  const fallback = await resolveFastEndpoints(config, storeOverride, authOverride, env, registry);
  const seen = new Set<string>();
  const ladder: ProviderEndpoint[] = [];
  for (const ep of [...primary, ...fallback]) {
    const key = `${ep.provider}/${ep.modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ladder.push(ep);
  }

  if (primary.length === 0 && fallback.length > 0) {
    appendRouterLog(
      `[ShiftRouter] Judge (${mode}) unusable — using the LLM judge ` +
        `(${fallback.map((e) => `${e.provider}/${e.modelId}`).join(", ")})`,
    );
  } else if (config?.ux?.routerLogVerbose) {
    appendRouterLog(
      `[ShiftRouter] Judge (${mode}) ladder: ` +
        ladder.map((e) => `${e.provider}/${e.modelId}`).join(" → "),
    );
  }
  return ladder;
}

// ─── Config validation (SPEC §5.4) ────────────────────────────────

/**
 * Validate that referenced models exist in the store.
 * Returns warnings (non-fatal): tier without models, missing provider/model, duplicates.
 */
export function validateConfig(config: ShiftRouterConfig, store: ModelsStore): string[] {
  const warnings: string[] = [];
  const seenRefs = new Map<string, string>(); // key → tier

  for (const tier of TIERS) {
    const cfg = config.tiers[tier];
    if (!cfg.models || cfg.models.length === 0) continue; // empty tier is OK
    for (const ref of cfg.models) {
      const key = `${ref.provider}/${ref.model}`;
      const providerModels = store[ref.provider];
      if (!providerModels) {
        warnings.push(`Provider "${ref.provider}" not found (tier "${tier}")`);
        continue;
      }
      const exists = providerModels.models.some((m) => m.id === ref.model);
      if (!exists) {
        warnings.push(`Model "${ref.model}" not found in provider "${ref.provider}" (tier "${tier}")`);
        continue;
      }
      // Track duplicate model references across tiers (informational)
      const prevTier = seenRefs.get(key);
      if (prevTier) {
        warnings.push(`Model "${key}" appears in both "${prevTier}" and "${tier}" — tier routing becomes a no-op`);
      } else {
        seenRefs.set(key, tier);
      }
    }
  }

  return warnings;
}

// ─── Config loading (user → project merge) ────────────────────────

/**
 * Load configuration with caching.
 * Layering:
 *   1. User config (~/.pi/agent/pi-shift-router.json) — personal defaults
 *   2. Project config (<cwd>/.pi/pi-shift-router.json) — team-shared overrides
 * Project wins on conflict (deep merge with project taking precedence).
 */
export async function loadConfig(cwd: string): Promise<ShiftRouterConfig> {
  if (_config) return _config;

  const userPath = userConfigPath();
  const projectPath = projectConfigPath(cwd);

  // Read both layers
  const userCfg = await readJsonPartial(userPath);
  const projectCfg = await readJsonPartial(projectPath);

  // Merge: defaults ← user ← project (project wins)
  const merged: ShiftRouterConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  deepMerge(merged as unknown as Record<string, unknown>, userCfg);
  deepMerge(merged as unknown as Record<string, unknown>, projectCfg);
  _config = merged;

  // Track which layer is authoritative (project if it exists, else user;
  // when neither exists the project path is the default WRITE target).
  _projectLayerExists = await fileExists(projectPath);
  _userLayerExists = await fileExists(userPath);
  _configSource = _projectLayerExists ? "project" : _userLayerExists ? "user" : "default";
  _configPath = _projectLayerExists ? projectPath
              : _userLayerExists ? userPath
              : projectPath; // default write target

  return merged;
}

/** Read partial JSON; tolerate missing files, malformed JSON, etc. */
async function readJsonPartial(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** Deep merge: target gets all values from source (plain objects only, arrays replaced). */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, val] of Object.entries(source)) {
    if (val === undefined) continue;
    const targetVal = target[key];
    if (
      val !== null &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      targetVal !== null &&
      typeof targetVal === "object" &&
      !Array.isArray(targetVal)
    ) {
      deepMerge(targetVal as Record<string, unknown>, val as Record<string, unknown>);
    } else {
      target[key] = val;
    }
  }
}