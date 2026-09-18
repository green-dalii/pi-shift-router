import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { piAgentDir } from "./config.js";

/**
 * Router diagnostics go to a FILE, never to stdout/stderr.
 *
 * Why: pi owns the terminal and renders its TUI frame by frame. Any stray
 * `console.log` lands between frames and the renderer's line accounting goes
 * out of sync — assistant text (e.g. the CTO summary) gets split mid-sentence
 * with log lines spliced in and wrapped lines overlap. Reported 2026-09-17
 * with `ux.routerLogVerbose` on. pi exposes no logging channel, so a file is
 * the only non-destructive sink.
 */

/** Env override — tests and unusual installs redirect the log with it. */
export const ROUTER_LOG_ENV = "PI_SHIFT_ROUTER_LOG";

/** `~/.pi/agent/logs/shift-router.log`, or `$PI_SHIFT_ROUTER_LOG` when set. */
export function routerLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[ROUTER_LOG_ENV];
  return override && override.trim() !== ""
    ? override
    : join(piAgentDir(), "logs", "shift-router.log");
}

/**
 * Append one timestamped diagnostic line. Returns false when the write
 * failed. Never throws and never falls back to console: a broken log must
 * not break routing, and a noisy fallback would re-introduce the very
 * frame corruption this module exists to prevent.
 */
export function appendRouterLog(
  line: string,
  path: string = routerLogPath(),
  now: number = Date.now(),
): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `[${new Date(now).toISOString()}] ${line}\n`, "utf-8");
    return true;
  } catch {
    return false;
  }
}
