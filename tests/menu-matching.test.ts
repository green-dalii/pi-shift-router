/**
 * pi-shift-router — Config wizard menu matching tests
 *
 * The wizard's `ctx.ui.select()` returns the full option label (emoji
 * prefixes included). Matching on those emoji is collision-prone — both
 * "🧠 Smart" and "🧠 Cache-aware routing" start with 🧠, which silently
 * routed Cache-aware into the Smart editor (regression fixed in v0.10.0).
 * These tests lock the keyword-based matching so a label edit can't
 * reintroduce a routing bug.
 */

import { describe, it, expect } from "vitest";
import { matchMenuChoice, matchSaveScope } from "../src/commands.js";

describe("matchMenuChoice", () => {
  it("routes Cache-aware before Smart (emoji collision regression)", () => {
    // "🛡 Cache-aware routing" must NOT be captured by the Smart branch.
    expect(matchMenuChoice("🛡 Cache-aware routing")).toBe("cache");
    // "🧠 Smart — 2 model(s) (CTO: direction, review, hard problems)"
    expect(matchMenuChoice("🧠 Smart — 2 model(s)  (CTO: direction, review, hard problems)")).toBe("smart");
  });

  it("matches every main-menu option by keyword", () => {
    expect(matchMenuChoice("🦾 Fast — 1 model(s)  (engineer: execution, daily coding)")).toBe("fast");
    expect(matchMenuChoice("🎨 UX settings")).toBe("ux");
    expect(matchMenuChoice("💾 Save & exit")).toBe("done");
    expect(matchMenuChoice("🚫 Discard & exit")).toBe("cancel");
    expect(matchMenuChoice("")).toBe("cancel");
  });

  it("does not confuse Smart with Cache-aware regardless of order", () => {
    expect(matchMenuChoice("🧠 Smart — 0 model(s)")).toBe("smart");
    expect(matchMenuChoice("🛡 Cache-aware routing")).toBe("cache");
  });
});

describe("matchSaveScope", () => {
  it("maps save-destination labels to scopes", () => {
    expect(matchSaveScope("📁 Project — <cwd>/.pi/pi-shift-router.json (shareable with team)")).toBe("project");
    expect(matchSaveScope("👤 User — ~/.pi/agent/pi-shift-router.json (personal)")).toBe("user");
    expect(matchSaveScope("🚫 Cancel save")).toBeNull();
    expect(matchSaveScope("")).toBeNull();
  });
});
