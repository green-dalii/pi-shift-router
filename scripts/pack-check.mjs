#!/usr/bin/env node
/**
 * pack-check.mjs
 *
 * Validates the publish-state of this package without actually publishing.
 * Catches the common pitfalls that would break the user-facing install path:
 *
 *   1. Stale value-imports of host packages (would fail at runtime in the
 *      extensions subtree).
 *   2. Accidentally-placed runtime dep that should be dev-only.
 *   3. Missing README, CHANGELOG, LICENSE files in the tarball.
 *   4. Wrong main entry, wrong `pi.extensions` path, wrong engines.
 *
 * Run via: `npm run pack:check`  (also runs as part of `prepublishOnly`).
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

let failures = 0;
const fail = (msg) => { console.error("✗", msg); failures++; };
const pass = (msg) => console.log("✓", msg);

// ---------- 1. Read package.json ----------
const pkgPath = join(ROOT, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

const HOST_PACKAGES = new Set(["@earendil-works/pi-coding-agent"]);
// Host-provided extension packages: pi's loader guarantees a single copy from
// the host and warns when an extension ALSO declares one in `dependencies`
// (duplicate runtime modules — two pi-tui copies break component identity and
// terminal state). The list mirrors `HOST_PROVIDED_EXTENSION_PACKAGES` in
// pi-coding-agent/dist/core/resource-loader.js (verified against 1.0.0).
const HOST_PROVIDED_DEP = new Set([
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"@mariozechner/pi-agent-core",
	"@mariozechner/pi-ai",
	"@mariozechner/pi-coding-agent",
	"@mariozechner/pi-tui",
	"@sinclair/typebox",
	"typebox",
]);
// The only host bundle this extension value-imports at runtime (the TUI
// wizard). Everything else stays type-only.
const PEER_HOST_BUNDLE = "@earendil-works/pi-tui";

const runtimeDeps = Object.keys(pkg.dependencies || {});
const devDeps = Object.keys(pkg.devDependencies || {});
const peerDeps = Object.keys(pkg.peerDependencies || {});
const runtimeDepsToSet = new Set(runtimeDeps);
const peerDepsToSet = new Set(peerDeps);

// ---------- 2b. Host-provided packages must NOT be runtime dependencies ----------
// pi's rule. Declaring one here makes npm install a second copy next to the
// host's, which the loader cannot dedupe.
const hostInDeps = runtimeDeps.filter((dep) => HOST_PROVIDED_DEP.has(dep));
if (hostInDeps.length > 0) {
	fail(
		`Host-provided package(s) in 'dependencies': ${hostInDeps.join(", ")}. ` +
		`pi 1.0.0 warns on this and for good reason — an installed copy bypasses the ` +
		`loader and creates duplicate runtime modules. Declare them in ` +
		`'peerDependencies' with a "*" range instead.`
	);
} else {
	pass("no host-provided package in 'dependencies'");
}
if (peerDepsToSet.has(PEER_HOST_BUNDLE)) {
	if (pkg.peerDependencies[PEER_HOST_BUNDLE] !== "*") {
		fail(`'${PEER_HOST_BUNDLE}' peer range must be exactly "*" (pi's host contract)`);
	} else {
		pass(`'${PEER_HOST_BUNDLE}' declared in peerDependencies with "*"`);
	}
} else {
	fail(`'${PEER_HOST_BUNDLE}' must be declared in 'peerDependencies' with a "*" range`);
}

// ---------- 3. Dist import rules ----------
//
// Why these rules exist (verified against pi 1.0.0
// dist/core/extensions/loader.js:468-481 and reproduced with a jiti 2.7 probe):
// * pi loads the extension ENTRY through jiti with an `alias` map that points
//   every host-provided specifier at the host's own copy. Anything reachable by
//   STATIC import is therefore aliased — that is why `dependencies` is not
//   needed and must not be used.
// * A native dynamic `import()` inside extension code is NOT rewritten by jiti.
//   The lazily loaded module is resolved by plain Node, where the host's copy is
//   not installed (pi's extension subtree is created with --omit=peer), so the
//   bare specifier fails with ERR_MODULE_NOT_FOUND. This was a real shape in
//   this repo (the config wizard lazily imported dist/tui/*), and the old
//   workaround — shipping pi-tui as a dependency — is exactly what pi now warns
//   about. The fix is to keep such imports static.
const DIST = join(ROOT, "dist");
const valueImportPatterns = [
	/^import\s+\{[^}]+\}\s+from\s+["']@earendil-works\/pi-coding-agent["']/m,
];
const staticHostImport = /(?:^|\n)\s*import\s[^;]*?from\s+["'](@earendil-works\/pi-tui)["']/;
const hostSubpathImport = /["']@earendil-works\/pi-tui\/[^"']+["']/;
const dynamicImportRe = /import\(\s*["']([^"']+)["']\s*\)/g;

function* walk(dir) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) yield* walk(p);
		else yield p;
	}
}

if (existsSync(DIST)) {
	const jsFiles = [...walk(DIST)].filter((f) => f.endsWith(".js"));
	const read = (f) => readFileSync(f, "utf8");
	let runtimeImportsFound = false;
	let hostImporters = 0;

	// Static graph + the set of modules that pull in a host bundle.
	const staticImports = new Map();
	for (const file of jsFiles) {
		const src = read(file);
		const specifiers = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
		staticImports.set(file, specifiers);
		if (staticHostImport.test(src)) hostImporters += 1;
		if (hostSubpathImport.test(src)) {
			fail(
				`${file.replace(ROOT + "/", "")} imports a SUBPATH of a host bundle. pi's alias map ` +
				`covers the bare specifier only — use '${PEER_HOST_BUNDLE}'.`
			);
		}
		for (const pat of valueImportPatterns) {
			if (pat.test(src)) {
				fail(
					`Runtime value-import of host package in ${file.replace(ROOT + "/", "")}. ` +
					`Compiled output retains the import; use 'import type' or pass dependencies through factory parameters.`
				);
				runtimeImportsFound = true;
			}
		}
	}

	// Reachability: does a dynamic import target (transitively) need a host bundle?
	const reachable = (entry) => {
		const seen = new Set();
		const queue = [entry];
		while (queue.length > 0) {
			const current = queue.pop();
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
	let dynamicHostReach = 0;
	for (const file of jsFiles) {
		const src = read(file);
		for (const m of src.matchAll(dynamicImportRe)) {
			const spec = m[1];
			if (!spec.startsWith(".")) continue;
			const target = resolve(dirname(file), spec);
			if (!existsSync(target)) continue;
			const needsHost = [...reachable(target)].some((f) => staticHostImport.test(read(f)));
			if (needsHost) {
				dynamicHostReach += 1;
				fail(
					`${file.replace(ROOT + "/", "")} dynamically imports '${spec}', which ` +
					`(transitively) imports ${PEER_HOST_BUNDLE}. jiti does not rewrite dynamic ` +
					`imports, so Node resolves it natively and the host bundle is not installed ` +
					`in pi's subtree — ERR_MODULE_NOT_FOUND at runtime. Make the import static.`
				);
			}
		}
	}
	if (dynamicHostReach === 0) pass("no dynamic import reaches a host-bundle importer");
	if (!runtimeImportsFound) pass("dist/ contains no runtime value-imports of host packages");
	if (hostImporters > 0) {
		pass(`${hostImporters} dist module(s) statically import ${PEER_HOST_BUNDLE} (aliased by the loader)`);
	}
} else {
	console.log("→ dist/ not found (run `npm run build` first)");
}

// ---------- 4. Required files exist and are in `files` list ----------
const REQUIRED_FILES = ["README.md", "LICENSE", "CHANGELOG.md", "dist/index.js", "dist/prompts/judge.md"];
const filesList = pkg.files || [];
for (const file of REQUIRED_FILES) {
	const fullPath = join(ROOT, file);
	if (!existsSync(fullPath)) {
		fail(`Required file missing on disk: ${file}`);
		continue;
	}
	const globPrefix = file.endsWith("/") ? file : `${file.split("/")[0]}`;
	const matched = filesList.some((f) => file === f || file.startsWith(f + "/") || f === globPrefix);
	if (!matched) {
		fail(`Required file '${file}' is not matched by 'files' in package.json`);
	} else {
		pass(`tarball includes: ${file}`);
	}
}

// ---------- 5. pi field sanity ----------
const pi = pkg.pi || {};
if (!pi.extensions || !Array.isArray(pi.extensions) || pi.extensions.length === 0) {
	fail("pi.extensions is missing or empty");
} else {
	const firstExt = pi.extensions[0];
	if (!existsSync(join(ROOT, firstExt))) {
		fail(`pi.extensions[0] = '${firstExt}' does not resolve on disk`);
	} else {
		pass(`pi.extensions[0] = ${firstExt} → exists`);
	}
}

// ---------- 6. engines.node declared ----------
const engines = pkg.engines || {};
if (!engines.node) {
	fail("engines.node is not declared — npm/pi install will warn on older Node");
} else {
	pass(`engines.node = ${engines.node}`);
}

// ---------- Summary ----------
console.log("");
if (failures === 0) {
	console.log("✓ pack:check passed — package is publish-ready");
	process.exit(0);
} else {
	console.error(`✗ pack:check found ${failures} issue(s) above — fix before publishing.`);
	process.exit(1);
}
