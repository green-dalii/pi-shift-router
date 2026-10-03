/**
 * pi-shift-router — Pack isolation tests
 *
 * Guards the regression class reported by npm-installed users, in the shape it
 * takes under pi 1.0.0's loader:
 *
 *   • pi loads the extension ENTRY through jiti with an `alias` map pointing
 *     every host-provided specifier at the host's own copy
 *     (`dist/core/extensions/loader.js`), so STATIC imports of a host bundle
 *     resolve to that single copy — no local install needed.
 *   • jiti does NOT rewrite native dynamic `import()`. A lazily imported module
 *     is resolved by plain Node, where the host bundle does not exist (pi
 *     installs the subtree with `--omit=peer --config.auto-install-peers=false`,
 *     see `dist/core/package-manager.js`) → `ERR_MODULE_NOT_FOUND`.
 *
 * So the contract these tests encode is: host bundles are peers, reached only
 * statically, and never installed locally. Shipping one in `dependencies` is the
 * duplicate-module hazard pi 1.0.0 warns about.
 *
 * Static (no network) — runs in every `npm test`. The end-to-end gate is
 * `scripts/check-isolated-load.mjs` (pack → isolated install → load every dist
 * module through jiti + the host alias), wired into CI as `check:isolated`.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { createRequire } from "node:module";

const ROOT = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/** Fallback list; the live one is read from pi below so host-contract changes surface here. */
const HOST_PROVIDED_FALLBACK = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "@sinclair/typebox",
  "typebox",
];

/** Read `HOST_PROVIDED_EXTENSION_PACKAGES` out of the installed pi, if present. */
function hostProvidedPackages(): string[] {
  try {
    const require_ = createRequire(join(ROOT, "package.json"));
    const piDir = dirname(require_.resolve("@earendil-works/pi-coding-agent", { paths: [join(ROOT, "node_modules")] }));
    const src = readFileSync(join(piDir, "core", "resource-loader.js"), "utf8");
    const block = src.match(/HOST_PROVIDED_EXTENSION_PACKAGES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    if (!block) return HOST_PROVIDED_FALLBACK;
    const names = [...block[1]!.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!);
    return names.length > 0 ? names : HOST_PROVIDED_FALLBACK;
  } catch {
    return HOST_PROVIDED_FALLBACK;
  }
}

const HOST_PROVIDED = new Set(hostProvidedPackages());

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

/** Static specifiers per module, plus which modules pull in a host bundle. */
function staticGraph(modules: string[]) {
  const staticImports = new Map<string, string[]>();
  const importsHost = new Set<string>();
  for (const mod of modules) {
    const src = readFileSync(mod, "utf8");
    staticImports.set(mod, [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!));
    if (runtimeExternalImports(mod).some((s) => HOST_PROVIDED.has(s))) importsHost.add(mod);
  }
  return { staticImports, importsHost };
}

describe("pack isolation (host bundles are peers, reached statically)", () => {
  const distDir = join(ROOT, "dist");
  const modules = walkDist(distDir);
  const deps = pkg.dependencies ?? {};
  const peers = pkg.peerDependencies ?? {};

  it("dist is built", () => {
    expect(existsSync(join(distDir, "index.js")), "dist/ is missing — run `npm run build` first (dist/ is gitignored; tests/pack-isolation reads the compiled artifact)").toBe(true);
    expect(modules.length, `only ${modules.length} dist modules found — run ` + "`npm run build` first").toBeGreaterThan(10);
  });

  it("the host contract is still the one this test assumes (pi aliases pi-tui)", () => {
    // Fails loudly if pi ever changes the mechanism, instead of silently
    // passing against a stale assumption.
    expect(HOST_PROVIDED.has("@earendil-works/pi-tui")).toBe(true);
    expect(peers["@earendil-works/pi-tui"]).toBe("*");
  });

  it("no host-provided package is a runtime dependency", () => {
    const offenders = Object.keys(deps).filter((d) => HOST_PROVIDED.has(d));
    expect(offenders, `host-provided package(s) in dependencies: ${offenders.join(", ")}`).toEqual([]);
  });

  it("every runtime external import in dist is covered — by a dependency or by the host alias", () => {
    const uncovered: string[] = [];
    for (const mod of modules) {
      for (const spec of runtimeExternalImports(mod)) {
        const coveredByDep = Boolean(deps[spec]);
        const coveredByHostAlias = HOST_PROVIDED.has(spec) && peers[spec] === "*";
        if (!coveredByDep && !coveredByHostAlias) uncovered.push(`${spec} ← ${mod.replace(ROOT + "/", "")}`);
      }
    }
    expect(uncovered).toEqual([]);
  });

  it("no dynamic import reaches a module that needs a host bundle", () => {
    // The regression this file exists for: a lazy `await import("./tui/x.js")`
    // is not rewritten by jiti, so Node resolves the host bundle natively and
    // fails. Host-bundle importers must be reachable statically only.
    const { staticImports, importsHost } = staticGraph(modules);
    const reachable = (entry: string): Set<string> => {
      const seen = new Set<string>();
      const queue = [entry];
      while (queue.length > 0) {
        const current = queue.pop()!;
        if (seen.has(current)) continue;
        seen.add(current);
        for (const spec of staticImports.get(current) ?? []) {
          if (!spec.startsWith(".")) continue;
          const next = resolve(dirname(current), spec);
          if (existsSync(next)) queue.push(next);
        }
      }
      return seen;
    };
    const offenders: string[] = [];
    for (const mod of modules) {
      const src = readFileSync(mod, "utf8");
      for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
        const spec = m[1]!;
        if (!spec.startsWith(".")) continue;
        const target = resolve(dirname(mod), spec);
        if (!existsSync(target)) continue;
        if ([...reachable(target)].some((f) => importsHost.has(f))) {
          offenders.push(`${mod.replace(ROOT + "/", "")} → ${spec}`);
        }
      }
    }
    expect(offenders, `dynamic import(s) reaching a host-bundle importer: ${offenders.join(", ")}`).toEqual([]);
  });

  it("pi-coding-agent stays devDependency-only (never a runtime dep)", () => {
    expect(pkg.dependencies?.["@earendil-works/pi-coding-agent"]).toBeUndefined();
    expect(pkg.peerDependencies?.["@earendil-works/pi-coding-agent"]).toBeUndefined();
  });
});
