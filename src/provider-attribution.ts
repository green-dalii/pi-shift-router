/**
 * pi-shift-router — provider attribution for our own outbound calls
 *
 * The router calls providers directly (the judge, the orchestrator auditor),
 * outside pi's own request path. Some gateways route per session and refuse
 * unattributed requests: OpenCode Go / Zen answers `400 MissingSessionID`
 * unless the call carries `x-opencode-session`, which strands the judge on
 * every turn (issue #48).
 *
 * This mirrors pi's `getSessionHeaders()`
 * (`pi-coding-agent/dist/core/provider-attribution.js`): the predicate is the
 * provider id (`opencode` / `opencode-go`) or a baseUrl whose hostname is
 * exactly `opencode.ai`, and only a real session id is attributed — pi sends
 * nothing without one. Keep in step with pi: a provider that starts requiring
 * another header is a change there first.
 */

import type { ProviderEndpoint } from "./types.js";

const OPENCODE_HOST = "opencode.ai";
const OPENCODE_PROVIDERS = new Set(["opencode", "opencode-go"]);

/** Hostname of `baseUrl`, or "" when it is not a URL at all. */
function hostnameOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "";
  }
}

/**
 * Session headers to attach to a direct provider call — `{}` when the provider
 * needs none, so call sites stay a plain spread.
 *
 * The hostname comparison is exact, matching pi: `opencode.ai.example.com` is
 * a different host and must not receive the session id.
 */
export function providerSessionHeaders(
  endpoint: Pick<ProviderEndpoint, "provider" | "baseUrl">,
  sessionId: string | undefined,
): Record<string, string> {
  const isOpenCode =
    OPENCODE_PROVIDERS.has(endpoint.provider) || hostnameOf(endpoint.baseUrl) === OPENCODE_HOST;
  if (!isOpenCode || !sessionId) return {};
  // Any non-empty value is accepted by the gateway; the real session id also
  // buys cache affinity, and is what pi sends for its own calls.
  return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}
