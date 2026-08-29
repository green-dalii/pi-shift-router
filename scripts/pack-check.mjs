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
import { join, dirname } from "node:path";
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
// Host packages that MUST be physically installed into the isolated extension
// subtree because the compiled .js dist cannot rely on pi's jiti alias/virtualModules
// rewrite (which is only reliable for TS-source extensions). npm installs these
// from the registry when declared in `dependencies`; the host still provides the
// canonical copy.
const RUNTIME_HOST_ALLOWLIST = new Set(["@earendil-works/pi-tui"]);
const runtimeDeps = Object.keys(pkg.dependencies || {});
const devDeps = Object.keys(pkg.devDependencies || {});
const peerDeps = Object.keys(pkg.peerDependencies || {});
const runtimeDepsToSet = new Set(runtimeDeps);
const peerDepsToSet = new Set(peerDeps);

// ---------- 2. Host packages must be devDeps, not deps ----------
for (const dep of runtimeDeps) {
	if (HOST_PACKAGES.has(dep)) {
		fail(
			`Runtime dependency '${dep}' must NOT be in 'dependencies' — the ` +
			`user's host (pi-coding-agent itself) already provides it. Move to ` +
			`'devDependencies' for type-checking only.`
		);
	} else if (RUNTIME_HOST_ALLOWLIST.has(dep)) {
		pass(`runtime dep: ${dep} (allowlisted host bundle — isolated-subtree install for compiled dist)`);
	} else {
		pass(`runtime dep: ${dep}`);
	}
}

for (const dep of devDeps) {
	if (HOST_PACKAGES.has(dep)) {
		pass(`host package '${dep}' correctly placed in devDependencies`);
	}
}

for (const dep of peerDeps) {
	if (HOST_PACKAGES.has(dep)) {
		fail(
			`Host package '${dep}' should NOT be in 'peerDependencies'. The host ` +
			`is the runtime itself — peer dependencies are NOT auto-installed by ` +
			`npm in pi's isolated extensions subtree. Use 'devDependencies'.`
		);
	}
}

// ---------- 3b. Allowlisted host bundles must be in BOTH deps + peers ----------
// pi's package-manager installs the extension subtree with --omit=peer and
// auto-install-peers=false, so a peerDependencies-only host bundle is never
// installed there. A compiled dist that value-imports such a bundle (pi-tui)
// fails at runtime with `Cannot find package`. The allowlisted bundle must be
// a real `dependencies` entry (npm installs it into the subtree) AND stay in
// peerDependencies (host contract).
for (const bundle of RUNTIME_HOST_ALLOWLIST) {
	if (!runtimeDepsToSet.has(bundle)) {
		fail(
			`Allowlisted host bundle '${bundle}' must be in 'dependencies' — pi's ` +
			`package-manager installs the extension subtree with --omit=peer, so a ` +
			`peerDependencies-only declaration is not installed there and compiled ` +
			`dist value-imports of it fail at runtime. Add it to 'dependencies'.`
		);
	} else {
		pass(`allowlisted host bundle '${bundle}' declared in dependencies`);
	}
	if (!peerDepsToSet.has(bundle)) {
		fail(`Allowlisted host bundle '${bundle}' must also stay in 'peerDependencies'.`);
	} else {
		pass(`allowlisted host bundle '${bundle}' declared in peerDependencies`);
	}
}

// ---------- 3. Source files must NOT value-import host packages ----------
const DIST = join(ROOT, "dist");
// Dist value-imports of allowlisted host bundles (pi-tui) are legal ONLY
// because 3b enforces they are real `dependencies` entries — they resolve
// from the isolated subtree via native Node resolution. The fail-scan below
// targets host packages that must NEVER be runtime-imported (pi-coding-agent:
// it is only ever type-imported; its runtime symbols come from the loader).
const valueImportPatterns = [
	/^import\s+\{[^}]+\}\s+from\s+["']@earendil-works\/pi-coding-agent["']/m,
];
const allowlistedValueImportPattern = /^import\s+\{[^}]+\}\s+from\s+["']@earendil-works\/pi-tui["']/m;

function* walk(dir) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) yield* walk(p);
		else yield p;
	}
}

if (existsSync(DIST)) {
	let runtimeImportsFound = false;
	for (const file of walk(DIST)) {
		if (!file.endsWith(".js")) continue;
		const content = readFileSync(file, "utf8");
		for (const pat of valueImportPatterns) {
			if (pat.test(content)) {
				fail(
					`Runtime value-import of host package in ${file.replace(ROOT + "/", "")}. ` +
					`Compiled output retains the import; Node would fail to resolve. ` +
					`Use 'import type' or pass dependencies through factory parameters.`
				);
				runtimeImportsFound = true;
			}
		}
		if (allowlistedValueImportPattern.test(content)) {
			// Legal: 3b guarantees the allowlisted bundle is in `dependencies`, so
			// it IS present in pi's isolated subtree (native resolution works).
			pass(`allowlisted host bundle value-import in ${file.replace(ROOT + "/", "")} (covered by dependencies)`);
		}
	}
	if (!runtimeImportsFound) {
		pass("dist/ contains no runtime value-imports of host packages");
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
