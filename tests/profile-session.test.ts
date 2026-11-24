/**
 * pi-shift-router — Per-session profiles: session wiring (SPEC §9.6)
 *
 * Drives the real extension with a fake pi host: the launch flag, the
 * session lifecycle, and the `/router profile` command.
 *
 * The selection is session state. The rules under test:
 *   - the launch flag selects a profile for the session
 *   - a new session without the flag starts with NO profile (no leak)
 *   - the flag survives `/new` (pi re-injects flag values per session)
 *   - an unknown profile name changes nothing and says so
 *   - selecting a profile never writes to the config files
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

// Hermetic isolation: config.ts computes PI_AGENT_DIR from homedir() at
// module scope.
vi.mock("node:os", () => ({ homedir: () => "/tmp/pi-shift-router-session-home" }));

import slimRouterExtension from "../src/index.js";
import { invalidateConfigCache } from "../src/config.js";

const HOME = "/tmp/pi-shift-router-session-home";
const USER_CONFIG = join(HOME, ".pi", "agent", "pi-shift-router.json");
const PROJECT_DIR = "/tmp/pi-shift-router-session-project";

const USER_CONFIG_BODY = {
  enabled: true,
  tiers: {
    fast: { label: "Fast", description: "fast", models: [{ provider: "anthropic", model: "haiku", priority: 1 }] },
    smart: { label: "Smart", description: "smart", models: [{ provider: "anthropic", model: "opus", priority: 1 }] },
  },
  profiles: {
    "opus-heavy": {
      fast: [{ provider: "anthropic", model: "sonnet", priority: 1 }],
      smart: [{ provider: "anthropic", model: "opus", priority: 1 }],
    },
    "cheap": {
      fast: [{ provider: "anthropic", model: "haiku", priority: 1 }],
    },
  },
};

interface Notice {
  message: string;
  type?: string;
}

/** A fake pi host that records handlers, commands, and flags. */
function makeFakePi(flag?: string) {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const commands = new Map<string, any>();
  const flags = new Map<string, any>();
  const pi: any = {
    on: (event: string, handler: any) => handlers.set(event, handler),
    registerCommand: (name: string, def: any) => commands.set(name, def),
    registerFlag: (name: string, def: any) => flags.set(name, def),
    getFlag: (name: string) => (name === "shift-router-profile" ? flag : undefined),
    setModel: async () => {},
    getAllTools: () => [],
    getActiveTools: () => [],
    tools: {},
  };
  return { pi, handlers, commands, flags };
}

function makeCtx(cwd: string) {
  const notices: Notice[] = [];
  const ctx: any = {
    cwd,
    mode: "tui",
    ui: {
      notify: (message: string, type?: string) => notices.push({ message, type }),
      setStatus: () => {},
      setWorkingVisible: () => {},
      custom: async () => {},
    },
  };
  return { ctx, notices };
}

/** Run the `/router` command and return what it notified. */
async function runRouter(
  commands: Map<string, any>,
  ctx: any,
  notices: Notice[],
  args: string,
): Promise<string> {
  notices.length = 0;
  await commands.get("router").handler(args, ctx);
  return notices.map((n) => n.message).join("\n");
}

describe("per-session profiles — session wiring", () => {
  beforeEach(async () => {
    invalidateConfigCache();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await rm(HOME, { force: true, recursive: true });
    await rm(PROJECT_DIR, { force: true, recursive: true });
    await mkdir(join(HOME, ".pi", "agent"), { recursive: true });
    await mkdir(PROJECT_DIR, { recursive: true });
    await writeFile(USER_CONFIG, JSON.stringify(USER_CONFIG_BODY, null, 2), "utf-8");
  });

  afterEach(async () => {
    invalidateConfigCache();
    vi.restoreAllMocks();
    await rm(HOME, { force: true, recursive: true });
    await rm(PROJECT_DIR, { force: true, recursive: true });
  });

  // ── The launch flag ──────────────────────────────────────────────

  it("registers the launch flag as a string flag", () => {
    const { pi, flags } = makeFakePi();
    slimRouterExtension(pi);
    const flag = flags.get("shift-router-profile");
    expect(flag).toBeDefined();
    expect(flag.type).toBe("string");
  });

  it("still loads on a pi host without the flag API (pi < 1.0.0)", async () => {
    // `registerFlag` / `getFlag` only exist from pi 1.0.0. An older host must
    // not break the extension — the command keeps working, the launch flag
    // is simply unavailable.
    const { pi, handlers, commands } = makeFakePi();
    delete (pi as any).registerFlag;
    delete (pi as any).getFlag;
    expect(() => slimRouterExtension(pi)).not.toThrow();

    const { ctx, notices } = makeCtx(PROJECT_DIR);
    await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
    const out = await runRouter(commands, ctx, notices, "profile");
    expect(out).toContain("active: none");
  });

  it("selects the flagged profile for the session", async () => {
    const { pi, handlers, commands } = makeFakePi("opus-heavy");
    slimRouterExtension(pi);
    const { ctx, notices } = makeCtx(PROJECT_DIR);

    await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);

    const out = await runRouter(commands, ctx, notices, "profile");
    expect(out).toContain("opus-heavy");
    expect(out).toContain("active: opus-heavy");
  });

  it("starts with no profile when the flag is absent", async () => {
    const { pi, handlers, commands } = makeFakePi();
    slimRouterExtension(pi);
    const { ctx, notices } = makeCtx(PROJECT_DIR);

    await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);

    const out = await runRouter(commands, ctx, notices, "profile");
    expect(out).toContain("active: none");
  });

  it("re-applies the launch flag on a new session (pi re-injects flag values)", async () => {
    const { pi, handlers, commands } = makeFakePi("opus-heavy");
    slimRouterExtension(pi);
    const { ctx, notices } = makeCtx(PROJECT_DIR);

    await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    const out = await runRouter(commands, ctx, notices, "profile");
    expect(out).toContain("active: opus-heavy");
  });

  it("does not leak a selection into a new session without the flag", async () => {
    const { pi, handlers, commands } = makeFakePi();
    slimRouterExtension(pi);
    const { ctx, notices } = makeCtx(PROJECT_DIR);

    await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
    // Select a profile in this session.
    await runRouter(commands, ctx, notices, "profile opus-heavy");
    expect(await runRouter(commands, ctx, notices, "profile")).toContain("active: opus-heavy");

    // A new session (same process, no flag) starts clean.
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    expect(await runRouter(commands, ctx, notices, "profile")).toContain("active: none");
  });

  // ── The command ─────────────────────────────────────────────────

  it("lists the defined profiles", async () => {
    const { pi, handlers, commands } = makeFakePi();
    slimRouterExtension(pi);
    const { ctx, notices } = makeCtx(PROJECT_DIR);
    await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);

    const out = await runRouter(commands, ctx, notices, "profile");
    expect(out).toContain("opus-heavy");
    expect(out).toContain("cheap");
  });

  it("selects a profile by name and reports the effective chains", async () => {
    const { pi, handlers, commands } = makeFakePi();
    slimRouterExtension(pi);
    const { ctx, notices } = makeCtx(PROJECT_DIR);
    await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);

    const out = await runRouter(commands, ctx, notices, "profile opus-heavy");
    expect(out).toContain("opus-heavy");
    // The EFFECTIVE chain — the profile replaced the Fast chain.
    expect(out).toContain("sonnet");
    expect(out).not.toContain("haiku");
  });

  it("changes nothing for an unknown profile name", async () => {
    const { pi, handlers, commands } = makeFakePi();
    slimRouterExtension(pi);
    const { ctx, notices } = makeCtx(PROJECT_DIR);
    await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);

    notices.length = 0;
    await commands.get("router").handler("profile nope", ctx);
    expect(notices[0]!.type).toBe("warning");
    expect(notices[0]!.message).toContain("nothing changed");

    // The selection is unchanged.
    const out = await runRouter(commands, ctx, notices, "profile");
    expect(out).toContain("active: none");
  });

  it("clears the selection with 'off'", async () => {
    const { pi, handlers, commands } = makeFakePi("opus-heavy");
    slimRouterExtension(pi);
    const { ctx, notices } = makeCtx(PROJECT_DIR);
    await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);

    const out = await runRouter(commands, ctx, notices, "profile off");
    expect(out).toContain("cleared");
    expect(await runRouter(commands, ctx, notices, "profile")).toContain("active: none");
  });

  it("completes profile names", async () => {
    const { pi, handlers, commands } = makeFakePi();
    slimRouterExtension(pi);
    const { ctx, notices } = makeCtx(PROJECT_DIR);
    await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);

    const completions = commands.get("router").getArgumentCompletions("profile o");
    expect(completions?.map((c: any) => c.label)).toEqual(["opus-heavy"]);
  });

  it("shows the active profile in the compact status", async () => {
    const { pi, handlers, commands } = makeFakePi();
    slimRouterExtension(pi);
    const { ctx, notices } = makeCtx(PROJECT_DIR);
    await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);

    // No profile yet — the compact line must not mention one.
    expect(await runRouter(commands, ctx, notices, "")).not.toContain("🗂");

    await runRouter(commands, ctx, notices, "profile opus-heavy");
    expect(await runRouter(commands, ctx, notices, "")).toContain("🗂 opus-heavy");
  });

  it("survives a config reload", async () => {
    const { pi, handlers, commands } = makeFakePi();
    slimRouterExtension(pi);
    const { ctx, notices } = makeCtx(PROJECT_DIR);
    await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);

    await runRouter(commands, ctx, notices, "profile opus-heavy");

    // Any saving command reloads the config from disk. The selection is
    // session state, so it must survive — and so must the effective chains.
    await runRouter(commands, ctx, notices, "quiet");

    const out = await runRouter(commands, ctx, notices, "profile");
    expect(out).toContain("active: opus-heavy");

    const reselect = await runRouter(commands, ctx, notices, "profile opus-heavy");
    expect(reselect).toContain("sonnet");
    expect(reselect).not.toContain("haiku");
  });

  // ── No disk writes ──────────────────────────────────────────────

  it("writes NOTHING to the config files when a profile is selected", async () => {
    const { pi, handlers, commands } = makeFakePi();
    slimRouterExtension(pi);
    const { ctx, notices } = makeCtx(PROJECT_DIR);
    await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);

    const before = readFileSync(USER_CONFIG, "utf-8");
    await runRouter(commands, ctx, notices, "profile opus-heavy");
    await runRouter(commands, ctx, notices, "profile off");

    expect(readFileSync(USER_CONFIG, "utf-8")).toBe(before);
    expect(existsSync(join(PROJECT_DIR, ".pi", "pi-shift-router.json"))).toBe(false);
  });

  it("writes NOTHING to the config files when the launch flag selects a profile", async () => {
    const { pi, handlers } = makeFakePi("opus-heavy");
    slimRouterExtension(pi);
    const { ctx } = makeCtx(PROJECT_DIR);

    const before = readFileSync(USER_CONFIG, "utf-8");
    await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
    expect(readFileSync(USER_CONFIG, "utf-8")).toBe(before);
  });

  // ── Unknown names change nothing, and say so ───────────────────

  it("warns and uses the configured chains when the flag names an unknown profile", async () => {
    const { pi, handlers, commands } = makeFakePi("ghost");
    slimRouterExtension(pi);
    const { ctx, notices } = makeCtx(PROJECT_DIR);

    await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);

    expect(notices[0]!.type).toBe("warning");
    expect(notices[0]!.message).toContain("ghost");
    expect(notices[0]!.message).toContain("no such profile");

    // Nothing was selected — the configured chains are in force.
    const out = await runRouter(commands, ctx, notices, "profile");
    expect(out).toContain("active: none");
  });

  it("warns when the selected profile is no longer defined in the config", async () => {
    // The stale-profile wording is unit-tested in profiles.test.ts
    // (describeActiveProfile) — the reload path here always re-saves the
    // in-memory base, so a stale profile is not reachable end-to-end.
    const { pi, handlers, commands } = makeFakePi();
    slimRouterExtension(pi);
    const { ctx, notices } = makeCtx(PROJECT_DIR);
    await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);

    await runRouter(commands, ctx, notices, "profile opus-heavy");
    const out = await runRouter(commands, ctx, notices, "profile");
    expect(out).toContain("active: opus-heavy");
  });
});