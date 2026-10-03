/**
 * pi-shift-router — Isolated-subtree load gate
 *
 * Loads the packed tarball the way pi actually loads an extension, and proves
 * the dependency closure is complete without shipping a copy of anything the
 * host provides.
 *
 * The model (verified against pi 1.0.0
 * `dist/core/extensions/loader.js:468-481` and reproduced with a jiti 2.7 probe):
 *
 *   1. pi installs the extension subtree with `--omit=peer
 *      --config.auto-install-peers=false` (`dist/core/package-manager.js`), so a
 *      `peerDependencies`-only host bundle is deliberately NOT installed there.
 *   2. pi loads the extension through **jiti** with an `alias` map that points
 *      every host-provided specifier (pi-tui included) at the host's own copy.
 *      Anything reachable through a STATIC import is therefore aliased, and a
 *      single copy is used.
 *   3. jiti does NOT rewrite native dynamic `import()`. A lazily imported module
 *      is resolved by plain Node, where the host bundle does not exist — that
 *      shape (`ERR_MODULE_NOT_FOUND`) is what `scripts/pack-check.mjs` forbids
 *      statically, so this gate only has to prove that the statically reachable
 *      graph loads with the alias and nothing local.
 *
 * Hence this script:
 *   • packs the working tree and installs it into a clean tree with pi's exact
 *     npm flags;
 *   • asserts NO host-provided package was installed into that tree (we must not
 *     ship a duplicate of the host's copy);
 *   • imports EVERY dist module through jiti with the host alias, mirroring
 *     `loader.js`. Exit 0 = the graph resolves against the host contract alone.
 *
 * Wired into CI and `npm run check:isolated`. Also runnable locally:
 *   node scripts/check-isolated-load.mjs
 */

import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = "/tmp"; // sandbox TMPDIR (/var/folders/...) denies mkdtemp; /tmp is reliable here and in CI
const work = mkdtempSync(join(TMP, "psr-isolated-"));
const NPM_ENV = { ...process.env, NPM_CONFIG_CACHE: "/tmp/npm-cache" };
let failed = false;

/** Host bundles the loader aliases; kept in sync with scripts/pack-check.mjs. */
const HOST_PROVIDED = ["@earendil-works/pi-tui"];

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

/**
 * jiti as pi bundles it. pi-coding-agent is a devDependency here, so ask for
 * jiti *from pi's own directory* (npm nests it there), then fall back to a
 * plain resolution for installs that hoist it.
 */
async function loadJiti() {
  const require_ = createRequire(join(ROOT, "package.json"));
  const candidates = [];
  for (const dir of [join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent"), ROOT]) {
    try {
      candidates.push(require_.resolve("jiti", { paths: [dir] }));
    } catch {
      /* try the next location */
    }
  }
  for (const candidate of candidates) {
    try {
      const mod = await import(pathToFileURL(candidate).href);
      const createJiti = mod.createJiti ?? mod.default?.createJiti;
      if (typeof createJiti === "function") return { createJiti, from: candidate };
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error("jiti not found (needed to mirror pi's extension loader)");
}

/** The host's alias target: our devDependency copy stands in for pi's own. */
function hostAliasTarget(specifier) {
  return fileURLToPath(import.meta.resolve(specifier));
}

try {
  // 1. Pack the current working tree into a tarball (what npm publish ships).
  const tarball = execFileSync("npm", ["pack", "--pack-destination", work, "--silent"], { cwd: ROOT, encoding: "utf8", env: NPM_ENV }).trim().split("\n").pop();
  if (!tarball || !existsSync(join(work, tarball))) {
    fail(`npm pack produced no tarball in ${work}`);
    process.exit(1);
  }
  pass(`packed ${tarball}`);

  // 2. Isolated install mirroring pi's package-manager exactly.
  execFileSync("npm", ["init", "-y"], { cwd: work, stdio: "ignore", env: NPM_ENV });
  execFileSync(
    "npm",
    ["install", "--omit=dev", "--omit=peer", "--config.auto-install-peers=false", "--no-audit", "--no-fund", "--loglevel=error", join(work, tarball)],
    { cwd: work, stdio: "ignore", env: NPM_ENV },
  );
  const installedRoot = work;
  pass(`installed ${tarball} (isolated tree: ${installedRoot}/node_modules)`);

  // 3. We must not ship a duplicate of anything the host provides — that is the
  //    hazard pi warns about (two pi-tui copies ⇒ split component/terminal state).
  for (const bundle of HOST_PROVIDED) {
    const local = join(installedRoot, "node_modules", ...bundle.split("/"));
    const nested = join(installedRoot, "node_modules", "pi-shift-router", "node_modules", ...bundle.split("/"));
    if (existsSync(local) || existsSync(nested)) {
      fail(`${bundle} was installed into the extension subtree — it is host-provided and must stay a peer dependency`);
    } else {
      pass(`no local copy of ${bundle} shipped (host-provided, as required)`);
    }
  }

  // 4. Load EVERY dist module the way pi does: jiti + host alias.
  const distRoot = join(installedRoot, "node_modules", "pi-shift-router", "dist");
  if (!existsSync(distRoot)) {
    fail(`dist not found in installed package: ${distRoot}`);
    process.exit(1);
  }
  const modules = walkDist(distRoot);
  const { createJiti, from } = await loadJiti();
  pass(`loading ${modules.length} dist modules through jiti (${from})`);

  const alias = Object.fromEntries(HOST_PROVIDED.map((spec) => [spec, hostAliasTarget(spec)]));
  const jiti = createJiti(import.meta.url, { alias, moduleCache: false });

  const results = [];
  for (const m of modules) {
    const label = m.split("/node_modules/")[1];
    try {
      await jiti.import(m);
      results.push(`OK ${label}`);
    } catch (e) {
      results.push(`FAIL ${label} → ${(e?.message || String(e)).split("\n")[0]}`);
    }
  }
  for (const line of results) {
    if (line.startsWith("OK")) pass(line.slice(3));
    else fail(line.slice(5));
  }
} catch (err) {
  fail(`isolated-load check failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failed) {
  console.error(
    "\n✗ Isolated-subtree load gate FAILED — an npm-installed user would hit this.\n" +
      "  Every runtime import must resolve through the host contract:\n" +
      "  static imports of host bundles (aliased by pi's loader) or real `dependencies`.",
  );
  process.exit(1);
}
console.log("\n✓ isolated-subtree load gate passed — every dist module loads through the host alias, no duplicate host bundle shipped.");
