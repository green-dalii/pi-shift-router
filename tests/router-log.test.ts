import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROUTER_LOG_ENV, appendRouterLog, routerLogPath } from "../src/log.js";

describe("router log — verbose diagnostics go to a file", () => {
  it("appends timestamped lines and creates missing directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "router-log-"));
    const path = join(dir, "nested", "logs", "shift-router.log");

    expect(appendRouterLog("first line", path, 1_700_000_000_000)).toBe(true);
    expect(appendRouterLog("second line", path, 1_700_000_001_000)).toBe(true);

    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] first line$/);
    expect(lines[1]).toContain("second line");
  });

  it("honours the PI_SHIFT_ROUTER_LOG override", () => {
    expect(routerLogPath({ [ROUTER_LOG_ENV]: "/tmp/custom-router.log" } as NodeJS.ProcessEnv)).toBe(
      "/tmp/custom-router.log",
    );
  });

  it("ignores a blank override and falls back to the pi agent dir", () => {
    expect(routerLogPath({ [ROUTER_LOG_ENV]: "   " } as NodeJS.ProcessEnv)).toMatch(
      /\.pi\/agent\/logs\/shift-router\.log$/,
    );
    expect(routerLogPath({} as NodeJS.ProcessEnv)).toMatch(/\.pi\/agent\/logs\/shift-router\.log$/);
  });

  it("returns false instead of throwing when the path is unwritable", () => {
    const dir = mkdtempSync(join(tmpdir(), "router-log-"));
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory");

    expect(appendRouterLog("nope", join(blocker, "child", "log.txt"))).toBe(false);
  });

  it("never writes to stdout/stderr (TUI frame safety)", () => {
    const dir = mkdtempSync(join(tmpdir(), "router-log-"));
    const path = join(dir, "log.txt");
    const stdoutWrite = process.stdout.write;
    const stderrWrite = process.stderr.write;
    let leaked = "";
    process.stdout.write = ((chunk: unknown) => {
      leaked += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      leaked += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      appendRouterLog("[ShiftRouter][diag] silence check", path);
      appendRouterLog("[ShiftRouter][diag] unwritable", join(dir, "x".repeat(300), "\u0000", "y"));
    } finally {
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
    }

    expect(leaked).toBe("");
  });
});
