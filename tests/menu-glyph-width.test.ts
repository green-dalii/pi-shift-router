/**
 * pi-shift-router — Menu glyph width guard (SPEC §7.6)
 *
 * A menu row's leading glyph must be WIDE. A glyph with
 * `Emoji_Presentation=No` (🗂 🗑 ⚠ ☑ ☐ …) and any plain arrow (← →) render
 * at half width, so the single space after them does not read as a gap — the
 * text looks glued to the icon, and the row does not match the ones around
 * it.
 *
 * The whole wizard leans on wide glyphs (🦾 🧠 🧭 🪄 🎨 🔒 🔄 💾 📁 👤 🚫 ✅
 * ❌ ➕ 📋 …), so one narrow glyph breaks the rhythm.
 *
 * The markers ● ○ ☑ ☐ and the warning ⚠ are deliberately narrow: they are
 * indicators, not icons, and they read correctly at half width.
 *
 * The test scans the SOURCE, not just the exported labels, so a narrow glyph
 * in a menu row that no test happens to render is still caught.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { profileLabel, profileListOptions, profileActionOptions } from "../src/profiles.js";
import { wizardMenuLabels } from "../src/commands.js";
import { DEFAULT_CONFIG, type ShiftRouterConfig } from "../src/types.js";

const SRC = join(import.meta.dirname, "..", "src");

/** Narrow by design: indicators, not icons. */
const MARKERS = new Set(["●", "○", "☑", "☐", "⚠"]);

/**
 * A leading character that could be a menu icon: an emoji-ish glyph, or one
 * of the arrow blocks (U+2190… is an "Other Symbol", not pictographic, and
 * would otherwise slip past a pictographic-only check).
 */
const ICON_LEAD = /^[\p{Extended_Pictographic}\p{Emoji_Presentation}←-⇿⤀-⥿]/u;

/** Renders at full width — the requirement for a menu icon. */
const WIDE = /^\p{Emoji_Presentation}$/u;

/** Every source file, as text. */
function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) files.push(path);
    }
  };
  walk(SRC);
  return files;
}

/**
 * String literals whose FIRST character is an icon-ish glyph — the position
 * where a menu row's icon sits.
 *
 * Only the leading character matters: arrows and other narrow symbols are
 * used inline all over the codebase (prose, log lines, chain-editor rows),
 * and they read correctly there. An arrow that OPENS a menu row is what
 * breaks the rhythm.
 */
function leadingIconLiterals(): string[] {
  const rows: string[] = [];
  for (const path of sourceFiles()) {
    const src = readFileSync(path, "utf8");
    for (const m of src.matchAll(/["'`]([^"'`\n]*)["'`]/g)) {
      const s = m[1]!;
      if (!ICON_LEAD.test(s)) continue;
      // A menu row is an icon, a space, and then TEXT. An icon on its own
      // ("🧠") or an arrow used as a status prefix ("→ ") is not a row.
      if (!/^\S+ \S/.test(s)) continue;
      rows.push(s);
    }
  }
  return rows;
}

describe("menu glyphs are wide", () => {
  it("no menu row opens with a narrow icon", () => {
    const offenders: string[] = [];
    for (const s of leadingIconLiterals()) {
      // The first CODE POINT, not the first UTF-16 unit: an astral emoji
      // starts with a lone surrogate half.
      const glyph = String.fromCodePoint(s.codePointAt(0)!);
      if (MARKERS.has(glyph)) continue;
      if (WIDE.test(glyph)) continue;
      offenders.push(`${glyph} (U+${glyph.codePointAt(0)!.toString(16).toUpperCase()}) in ${JSON.stringify(s.slice(0, 40))}`);
    }
    expect(
      offenders,
      `narrow leading glyph(s) — they render at half width and crowd the text: ${offenders.join("; ")}`,
    ).toEqual([]);
  });

  it("the glyph set the wizard relies on is wide", () => {
    const used = ["🦾", "🧠", "🧭", "🪄", "🎨", "🔒", "🔄", "💾", "📁", "👤", "🚫", "✅", "❌", "➕", "📋"];
    for (const glyph of used) {
      expect(WIDE.test(glyph), `${glyph} (U+${glyph.codePointAt(0)!.toString(16).toUpperCase()}) is not a wide glyph`).toBe(true);
    }
  });
});

describe("menu rows keep exactly one space after the glyph", () => {
  it("every glyph is followed by exactly one space and then text", () => {
    const offenders = leadingIconLiterals().filter(
      (s) => !/^[●○☑☐]? ?[\p{Extended_Pictographic}\p{Emoji_Presentation}][️]? [$A-Za-z0-9(]/u.test(s),
    );
    expect(offenders, `menu rows with a broken gap: ${JSON.stringify(offenders)}`).toEqual([]);
  });

  it("the guard actually sees the rows it is meant to guard", () => {
    // A guard that silently matches nothing is worse than no guard.
    const rows = leadingIconLiterals();
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.some((r) => r.includes("Profiles"))).toBe(true);
    expect(rows.some((r) => r.includes("Fast chain"))).toBe(true);
  });

  it("the profile rows keep the indicator idiom (● current / ○ other)", () => {
    // Built from a template, so the source scan cannot see them.
    const row = profileLabel("sonnet", { fast: [], smart: [] });
    expect(row).toMatch(/^[●○] \S/);
    expect(profileLabel("sonnet", {}, "sonnet")).toMatch(/^● /);
    expect(profileLabel("sonnet", {}, "other")).toMatch(/^○ /);
  });
});

// ─── One glyph per meaning ─────────────────────────────────────────

describe("no two rows of one menu share a glyph", () => {
  /**
   * The leading glyph of a row, or null when the row starts with a radio
   * marker (● ○). The markers are an exclusive-picker idiom — repetition
   * is the POINT there, so they are not "the same icon".
   */
  function iconOf(row: string): string | null {
    const glyph = String.fromCodePoint(row.codePointAt(0)!);
    return glyph === "●" || glyph === "○" ? null : glyph;
  }

  function assertDistinctIcons(rows: string[], where: string) {
    const icons = rows.map(iconOf).filter((g): g is string => g !== null);
    const dupes = icons.filter((g, i) => icons.indexOf(g) !== i);
    expect(
      [...new Set(dupes)],
      `${where}: the same icon opens more than one row, so they look like the same action`,
    ).toEqual([]);
  }

  function configWithProfiles(): ShiftRouterConfig {
    const config: ShiftRouterConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    config.profiles = { a: { fast: [] }, b: { smart: [] } };
    return config;
  }

  it("the profiles list has one icon per row", () => {
    assertDistinctIcons(profileListOptions(configWithProfiles(), "a"), "the profiles list");
  });

  it("the profile actions have one icon per row", () => {
    const profile = { fast: [], smart: [] };
    assertDistinctIcons(profileActionOptions(profile, false), "the profile actions (inactive)");
    assertDistinctIcons(profileActionOptions(profile, true), "the profile actions (active)");
  });

  it("the wizard's main menu has one icon per row", () => {
    assertDistinctIcons(wizardMenuLabels(configWithProfiles(), 42, 1), "the wizard's main menu");
  });

  it("the same icon never means two different things across the wizard", () => {
    // Collect every icon the wizard uses, per menu, and check the PROFILE
    // menus specifically: an icon reused across the profile menus for two
    // different actions is the trap this guards.
    const menus = [
      profileListOptions(configWithProfiles(), null),
      profileActionOptions({ fast: [], smart: [] }, false),
      profileActionOptions({ fast: [], smart: [] }, true),
    ];
    for (const rows of menus) assertDistinctIcons(rows, "a profile menu");
  });

  it("the disable row and the delete row are different icons", () => {
    // The trap the user hit: two rows, one icon, two very different actions.
    const rows = profileActionOptions({ fast: [], smart: [] }, true);
    const disable = rows.find((r) => r.includes("Disable"))!;
    const del = rows.find((r) => r.includes("Delete"))!;
    expect(iconOf(disable)).not.toBe(iconOf(del));
  });
});

// ─── No shadowed type declarations ────────────────────────────────

describe("a type is declared once", () => {
  it("commands.ts declares MenuChoice once", () => {
    // An inner `type MenuChoice` shadows the module-level one. The two were
    // identical, but a shadow means the outer one can drift and nobody
    // notices — the compiler never complains.
    const src = readFileSync("src/commands.ts", "utf8");
    const declarations = [...src.matchAll(/^\s*type MenuChoice\b/gm)];
    expect(
      declarations.length,
      `MenuChoice is declared ${declarations.length} times — the inner one shadows the outer`,
    ).toBe(1);
  });
});
