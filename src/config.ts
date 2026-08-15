/**
 * pi-shift-router — Configuration loader
 *
 * Reads pi-agent's models-store.json (built-in catalog), models.json (custom providers),
 * and auth.json, resolves Judge endpoint,
 * and manages the pi-shift-router.json config file (user-level + project-level).
 */

import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import {
  type ShiftRouterConfig,
  type ModelsStore,
  type AuthStore,
  type ProviderEntry,
  type StoredModel,
  type ProviderEndpoint,
  DEFAULT_CONFIG,
  TIERS,
} from "./types.js";

const PI_AGENT_DIR = join(homedir(), ".pi", "agent");
const CONFIG_FILENAME = "pi-shift-router.json";

let _config: ShiftRouterConfig | null = null;
let _modelsStore: ModelsStore | null = null;
let _authStore: AuthStore | null = null;
let _configPath: string | null = null;

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
 * Expand `$VAR` / `${VAR}` / `$$` / `$!` (pi models.json escape rules). Empty expansion → undefined.
 * Shell commands (`!cmd`) are resolved by pi at request time — unsupported here, so the value
 * stays unresolvable and the provider falls back to auth.json or is skipped.
 */
export function expandEnv(value: string | undefined, env: Record<string, string | undefined> = process.env): string | undefined {
  if (value === undefined) return undefined;
  if (value.startsWith("!")) return undefined;
  const expanded = value.replace(/\$\$|\$!|\$\{(\w+)\}|\$(\w+)/g, (m, braced, plain) =>
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

/** Load models-store.json (built-in catalog), merged with custom providers from models.json. */
export async function loadModelsStore(): Promise<ModelsStore> {
  if (_modelsStore) return _modelsStore;
  let builtin: ModelsStore = {};
  try {
    builtin = JSON.parse(await readFile(join(PI_AGENT_DIR, "models-store.json"), "utf-8")) as ModelsStore;
  } catch {
    // missing/malformed built-in catalog is not fatal
  }
  let custom: { providers?: Record<string, ProviderEntry> } = {};
  try {
    custom = JSON.parse(await readFile(join(PI_AGENT_DIR, "models.json"), "utf-8")) as { providers?: Record<string, ProviderEntry> };
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
  // Note: _modelsStore and _authStore are not invalidated — they reflect
  // pi-agent's own state, which we don't own.
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
export async function resolveFastEndpoints(
  config: ShiftRouterConfig,
  storeOverride?: ModelsStore,
  authOverride?: AuthStore,
  env: Record<string, string | undefined> = process.env,
): Promise<ProviderEndpoint[]> {
  const store = storeOverride ?? (await loadModelsStore());
  const auth = authOverride ?? (await loadAuthStore());

  async function resolve(provider: string, modelId: string): Promise<ProviderEndpoint | null> {
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

  const endpoints: ProviderEndpoint[] = [];

  // 1. Fast tier chain, in priority order.
  const fastModels = [...(config.tiers.fast.models ?? [])].sort((a, b) => a.priority - b.priority);
  for (const ref of fastModels) {
    const ep = await resolve(ref.provider, ref.model);
    if (ep) endpoints.push(ep);
  }
  if (endpoints.length > 0) {
    console.log(`[ShiftRouter] Judge endpoints: ${endpoints.map((e) => `${e.provider}/${e.modelId}`).join(", ")}`);
    return endpoints;
  }

  // 2. Fallback: cheapest model with auth.
  const candidates: Array<{ provider: string; modelId: string; cost: number }> = [];
  for (const [prov, entry] of Object.entries(store)) {
    if (!(auth[prov]?.key ?? expandEnv(entry.apiKey, env))) continue;
    for (const m of entry.models) {
      const cost = m.cost?.input ?? Number.MAX_SAFE_INTEGER;
      if (cost >= 0) candidates.push({ provider: prov, modelId: m.id, cost });
    }
  }
  candidates.sort((a, b) => a.cost - b.cost);
  if (candidates.length === 0) {
    console.warn("[ShiftRouter] Judge: no provider with valid API key found — cannot resolve judge endpoint");
    return [];
  }
  const cheapest = candidates[0];
  const ep = await resolve(cheapest.provider, cheapest.modelId);
  if (ep) {
    console.warn(`[ShiftRouter] Judge: fast tier unavailable, falling back to cheapest: ${cheapest.provider}/${cheapest.modelId}`);
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

  // Track which path is authoritative (project if exists, else user if exists)
  _configPath = (await fileExists(projectPath)) ? projectPath
              : (await fileExists(userPath))   ? userPath
              : projectPath; // default write target

  // Validate and warn (non-fatal)
  try {
    const store = await loadModelsStore();
    const warnings = validateConfig(merged, store);
    if (warnings.length > 0) {
      console.warn(`[ShiftRouter] Config warnings:\n  ${warnings.join("\n  ")}`);
    }
  } catch {
    // Validation failure should never block startup
  }

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