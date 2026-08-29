/**
 * pi-shift-router — Isolated-subtree load gate
 *
 * Reproduces the EXACT failure mode reported by npm-installed users:
 * `pi install npm:pi-shift-router` places the tarball into an isolated
 * extension subtree with only its own `dependencies` installed (peer
 * dependencies are NOT installed by npm there). If any compiled dist module
 * value-imports a host bundle (e.g. @earendil-works/pi-tui) that is not a
 * real `dependencies` entry, native Node resolution fails with
 * `Cannot find package '...'` at runtime (see dist/tui/* — the config
 * wizard's lazy import path).
 *
 * This script packs the package, installs the tarball into a clean temp
 * tree with `--omit=dev` (mirroring pi's isolated subtree), then NATIVELY
 * imports every dist module. Exit 0 = every runtime external import
 * resolves from the dependency closure; non-zero otherwise.
 *
 * Wired into CI and `npm run check:isolated`. Also runnable locally:
 *   node scripts/check-isolated-load.mjs
 */

import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = "/tmp"; // sandbox TMPDIR (/var/folders/...) denies mkdtemp; /tmp is reliable here and in CI
const work = mkdtempSync(join(TMP, "psr-isolated-"));
const NPM_ENV = { ...process.env, NPM_CONFIG_CACHE: "/tmp/npm-cache" };
let failed = false;

const fail = (msg) => { console.error("✗", msg); failed = true; };
const pass = (msg) => console.log("✓", msg);

function walkDist(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walkDist(p));
    else if (e.endsWith(".js")) out.push(p);
  }
  return out;
}

try {
  // 1. Pack the current working tree into a tarball (what npm publish ships).
  const tarball = execFileSync("npm", ["pack", "--pack-destination", work, "--silent"], { cwd: ROOT, encoding: "utf8", env: NPM_ENV }).trim().split("\n").pop();
  if (!tarball || !existsSync(join(work, tarball))) {
    fail(`npm pack produced no tarball in ${work}`);
    process.exitCode = 1;
    process.exit(1);
  }
  pass(`packed ${tarball}`);

  // 2. Isolated install mirroring pi's package-manager (`dist/core/package-manager.js`):
  //    pi deliberately does NOT install peerDependencies into the extension subtree,
  //    so a compiled dist that value-imports a peerDep-only host bundle (pi-tui)
  //    fails exactly like the reported user error. Only real `dependencies` are present.
  execFileSync("npm", ["init", "-y"], { cwd: work, stdio: "ignore", env: NPM_ENV });
  execFileSync(
    "npm",
    ["install", "--omit=dev", "--omit=peer", "--config.auto-install-peers=false", "--no-audit", "--no-fund", "--loglevel=error", join(work, tarball)],
    { cwd: work, stdio: "ignore", env: NPM_ENV },
  );
  const installedRoot = work;
  pass(`installed ${tarball} (isolated tree: ${installedRoot}/node_modules)`);

  // 3. Native ESM import of EVERY dist module — strictest resolution, the one
  //    Node uses when pi's loader does not rewrite the specifier.
  const distRoot = join(installedRoot, "node_modules", "pi-shift-router", "dist");
  if (!existsSync(distRoot)) {
    fail(`dist not found in installed package: ${distRoot}`);
    process.exit(1);
  }
  const modules = walkDist(distRoot);
  pass(`probing ${modules.length} dist modules via native import()`);

  const probePath = join(work, "probe.mjs");
  writeFileSync(
    probePath,
    [
      "const mods = " + JSON.stringify(modules) + ";",
      "for (const m of mods) {",
      "  try { await import('file://' + m); console.log('OK', m.split('/node_modules/')[1]); }",
      "  catch (e) { console.error('FAIL', m.split('/node_modules/')[1], '→', (e.message || '').split('\\n')[0]); process.exitCode = 1; }",
      "}",
    ].join("\n"),
  );
  const probeOut = execFileSync("node", [probePath], { cwd: installedRoot, encoding: "utf8" });
  for (const line of probeOut.trim().split("\n")) {
    if (line.startsWith("OK")) pass(line.slice(3));
    else if (line.startsWith("FAIL")) fail(line.slice(5));
  }
} catch (err) {
  fail(`isolated-load check failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failed) {
  console.error("\n✗ Isolated-subtree load gate FAILED — an npm-installed user would hit this.\n  Ensure every dist runtime import is covered by package.json `dependencies` (see scripts/pack-check.mjs RUNTIME_HOST_ALLOWLIST).");
  process.exit(1);
}
console.log("\n✓ isolated-subtree load gate passed — every dist module resolves from the dependency closure.");
