/**
 * pi-shift-router — Pack isolation tests
 *
 * Guards the exact regression class reported by npm-installed users:
 * compiled dist modules value-importing a host bundle (@earendil-works/pi-tui)
 * that pi's package-manager will NOT install into the isolated extension
 * subtree (it installs with `--omit=peer --config.auto-install-peers=false`,
 * see pi's dist/core/package-manager.js). A peerDependencies-only declaration
 * is therefore NOT enough for compiled `.js` — the bundle must be a real
 * `dependencies` entry so it lands in the subtree and native Node resolution
 * finds it.
 *
 * Static (no network) — runs in every `npm test`. The deeper end-to-end
 * gate is `scripts/check-isolated-load.mjs` (pack → isolated install → native
 * import of every dist module), wired into CI as `npm run check:isolated`.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

function walkDist(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkDist(p, acc);
    else if (e.name.endsWith(".js")) acc.push(p);
  }
  return acc;
}

function runtimeExternalImports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/from\s+["']([^"'.][^"']*)["']/g)) if (!m[1]!.startsWith("node:")) out.push(m[1]!);
  return out;
}

describe("pack isolation (compiled dist must resolve in pi's isolated subtree)", () => {
  const distDir = join(ROOT, "dist");
  const modules = walkDist(distDir);
  const deps = pkg.dependencies ?? {};

  it("dist is built", () => {
    // dist/ is gitignored; the packaging gates read the compiled artifact.
    // CI runs `npm run build` before `npm test`; locally run `npm run build` first.
    expect(existsSync(join(distDir, "index.js")), "dist/ is missing — run `npm run build` first (dist/ is gitignored; tests/pack-isolation reads the compiled artifact)").toBe(true);
    expect(modules.length, `only ${modules.length} dist modules found — run ` + "`npm run build` first").toBeGreaterThan(10);
  });

  it("every runtime external import in dist is covered by `dependencies`", () => {
    // pi installs the extension subtree with --omit=peer + auto-install-peers=false.
    // Any import not covered by `dependencies` fails at runtime (the reported
    // `Cannot find package '@earendil-works/pi-tui'` error).
    const uncovered = new Set<string>();
    for (const mod of modules) {
      for (const spec of runtimeExternalImports(mod)) {
        if (!deps[spec]) uncovered.add(`${spec} ← ${join("dist", mod.split("dist/")[1] ?? "")}`);
      }
    }
    expect([...uncovered]).toEqual([]);
  });

  it("host bundles that dist value-imports are declared in dependencies (pi-tui)", () => {
    const tuiImports = modules.filter((m) => m.includes("/tui/")).length;
    expect(tuiImports).toBeGreaterThan(0);
    // The TUI modules value-import @earendil-works/pi-tui at runtime.
    const tuiNeedsPiTui = modules
      .filter((m) => m.includes("/tui/"))
      .every((m) => runtimeExternalImports(m).includes("@earendil-works/pi-tui"));
    expect(tuiNeedsPiTui).toBe(true);
    // ...so pi-tui MUST be a real dependency (peerDependencies alone is not
    // installed into the subtree by pi's package-manager).
    expect(deps["@earendil-works/pi-tui"]).toBeTruthy();
  });

  it("pi-coding-agent stays devDependency-only (never a runtime dep)", () => {
    expect(pkg.dependencies?.["@earendil-works/pi-coding-agent"]).toBeUndefined();
    expect(pkg.peerDependencies?.["@earendil-works/pi-coding-agent"]).toBeUndefined();
  });
});
