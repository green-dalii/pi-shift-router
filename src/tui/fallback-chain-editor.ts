/**
 * pi-shift-router — Fallback chain editor TUI component.
 *
 * A self-contained editor for a tier's model priority list.
 * Two modes: 'list' (numbered chain with hotkeys) and 'picker'
 * (type-to-filter model selection for adding).
 *
 * Composes pi-tui primitives only: Container, Input, Text, Spacer,
 * fuzzyFilter, getKeybindings. Same pattern as ModelPickerComponent.
 */
import { Container, Input, Text, Spacer, fuzzyFilter, getKeybindings } from "@earendil-works/pi-tui";
import type { Focusable } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ModelRef, StoredModel, Tier } from "../types.js";

const MAX_VISIBLE = 10;

// ─── Key matching helpers (pure, exported for testing) ─────────────

/** Case-insensitive single-character key match. Accepts `a` or `A` for key `"a"`. */
export function isSingleKey(data: string, key: string): boolean {
	return data.length === 1 && data.toLowerCase() === key.toLowerCase();
}

/** Shift+Up — ANSI: ESC [ 1 ; 2 A (best-effort, some terminals don't send it). */
export function isReorderUpKey(data: string): boolean {
	return data === "\x1b[1;2A";
}

/** Shift+Down — ANSI: ESC [ 1 ; 2 B (best-effort, some terminals don't send it). */
export function isReorderDownKey(data: string): boolean {
	return data === "\x1b[1;2B";
}

/**
 * Decide reorder direction from a key press.
 * Primary: plain `k` (up) / `j` (down) — portable across all terminals.
 * Best-effort: Shift+↑ / Shift+↓ ANSI escape sequences where supported.
 * Returns null when the key is not a reorder key.
 */
export function reorderDirection(data: string): "up" | "down" | null {
	if (isSingleKey(data, "k") || isReorderUpKey(data)) return "up";
	if (isSingleKey(data, "j") || isReorderDownKey(data)) return "down";
	return null;
}

// ─── Pure state transitions (exported for testing) ─────────────────

export function chainEditorAdd(items: ModelRef[], ref: ModelRef): ModelRef[] {
	return [...items, ref];
}

export function chainEditorRemove(items: ModelRef[], cursor: number): { items: ModelRef[]; cursor: number } {
	if (items.length === 0) return { items, cursor: 0 };
	const updated = items.filter((_, i) => i !== cursor);
	const newCursor = Math.min(cursor, Math.max(0, updated.length - 1));
	return { items: updated, cursor: newCursor };
}

export function chainEditorMoveUp(items: ModelRef[], cursor: number): { items: ModelRef[]; cursor: number } {
	if (cursor <= 0) return { items, cursor };
	const updated = [...items];
	const tmp = updated[cursor];
	updated[cursor] = updated[cursor - 1];
	updated[cursor - 1] = tmp;
	return { items: updated, cursor: cursor - 1 };
}

export function chainEditorMoveDown(items: ModelRef[], cursor: number): { items: ModelRef[]; cursor: number } {
	if (cursor >= items.length - 1) return { items, cursor };
	const updated = [...items];
	const tmp = updated[cursor];
	updated[cursor] = updated[cursor + 1];
	updated[cursor + 1] = tmp;
	return { items: updated, cursor: cursor + 1 };
}

/** Reassign priorities by position (1-based). */
export function reassignPriorities(items: ModelRef[]): ModelRef[] {
	return items.map((item, i) => ({ ...item, priority: i + 1 }));
}

// ─── TUI component ─────────────────────────────────────────────────

/** Local SelectListTheme derived from pi Theme — same pattern as model-picker. */
interface SelectListTheme {
	selectedPrefix: (text: string) => string;
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
}

function getLocalTheme(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("muted", text),
		noMatch: (text) => theme.fg("muted", text),
	};
}

export interface ChainEditorOptions {
	items: ModelRef[];
	allModels: StoredModel[];
	tier: Tier;
	tierLabel: string;
	theme: Theme;
	unavailableKeys?: Set<string>;
	onDone: (items: ModelRef[]) => void;
	onCancel: () => void;
}

type EditorMode =
	| { kind: "list" }
	| { kind: "picker" };

export class ChainEditorComponent extends Container implements Focusable {
	private items: ModelRef[];
	private cursor: number;
	private mode: EditorMode;
	private allModels: StoredModel[];
	private tierLabel: string;
	private unavailableKeys: Set<string>;
	private onDone: (items: ModelRef[]) => void;
	private onCancel: () => void;
	private theme: SelectListTheme;

	// Picker sub-state (used in 'picker' mode)
	private searchInput: Input;
	private pickerContainer: Container;
	private filteredModels: StoredModel[] = [];
	private selectedIndex = 0;

	// Focusable
	private _focused = false;
	get focused(): boolean { return this._focused; }
	set focused(v: boolean) { this._focused = v; if (this.mode.kind === "picker") this.searchInput.focused = v; }

	constructor(opts: ChainEditorOptions) {
		super();
		this.items = [...opts.items];
		this.cursor = 0;
		this.mode = { kind: "list" };
		this.allModels = opts.allModels;
		this.tierLabel = opts.tierLabel;
		this.unavailableKeys = opts.unavailableKeys ?? new Set<string>();
		this.onDone = opts.onDone;
		this.onCancel = opts.onCancel;
		this.theme = getLocalTheme(opts.theme);
		this.searchInput = new Input();
		this.pickerContainer = new Container();

		this.rebuild();
		this.searchInput.focused = false;
	}

	// ── Build / rebuild the entire child tree ────────────────────

	private rebuild(): void {
		this.clear();

		if (this.mode.kind === "picker") {
			this.renderPicker();
		} else {
			this.renderList();
		}
	}

	private renderList(): void {
		// Header
		this.addChild(new Text(this.theme.selectedText(`Edit ${this.tierLabel} models`), 0, 0));
		this.addChild(new Spacer(1));

		// Model list
		if (this.items.length === 0) {
			this.addChild(new Text(this.theme.noMatch("  No models — press a to add"), 0, 0));
		} else {
			for (let i = 0; i < this.items.length; i++) {
				const item = this.items[i]!;
				const isCursor = i === this.cursor;
				const num = `#${i + 1}`;
				const key = `${item.provider}/${item.model}`;
				const unavailable = this.unavailableKeys.has(key);
				const suffix = unavailable ? " (unavailable)" : "";
				const base = `${num}  ${item.provider}/${item.model}${suffix}`;
				const prefix = isCursor ? this.theme.selectedPrefix("→ ") : "  ";
				// Unavailable entries are muted; available entries use accent when selected.
				const label = unavailable
					? this.theme.description(base)
					: isCursor
						? this.theme.selectedText(base)
						: base;
				this.addChild(new Text(`  ${prefix}${label}`, 0, 0));
			}
		}

		this.addChild(new Spacer(1));
		this.addChild(new Text(
			this.theme.description("Press: ↑↓ select · A add · X remove · J/K move · D done · Esc cancel"),
			0, 0,
		));
		if (this.unavailableKeys.size > 0) {
			this.addChild(new Text(
				this.theme.description("(unavailable) = not in catalog or no auth"),
				0, 0,
			));
		}
	}

	private renderPicker(): void {
		this.addChild(new Text(this.theme.selectedText(`Add model to ${this.tierLabel}`), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.pickerContainer);
		this.addChild(new Spacer(1));
		this.addChild(new Text(
			this.theme.description("Type to filter · ↑↓ select · Enter confirm · Esc cancel"),
			0, 0,
		));

		this.filterModels(this.searchInput.getValue());
		this.updatePickerList();
	}

	private filterModels(query: string): void {
		const q = query.trim().toLowerCase();
		this.filteredModels = q
			? fuzzyFilter(this.allModels, q, (m) => `${m.id} ${m.provider}`)
			: this.allModels;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.updatePickerList();
	}

	private updatePickerList(): void {
		this.pickerContainer.clear();

		const total = this.filteredModels.length;
		if (total === 0) {
			this.pickerContainer.addChild(new Text(this.theme.noMatch("  No matching models"), 0, 0));
			return;
		}

		const startIndex = Math.max(0, Math.min(
			this.selectedIndex - Math.floor(MAX_VISIBLE / 2),
			total - MAX_VISIBLE,
		));
		const endIndex = Math.min(startIndex + MAX_VISIBLE, total);

		for (let i = startIndex; i < endIndex; i++) {
			const m = this.filteredModels[i]!;
			const isSelected = i === this.selectedIndex;
			const arrow = isSelected ? this.theme.selectedPrefix("→ ") : "  ";
			const name = isSelected ? this.theme.selectedText(m.id) : m.id;
			const badge = this.theme.description(`[${m.provider}]`);
			this.pickerContainer.addChild(new Text(`  ${arrow}${name} ${badge}`, 0, 0));
		}

		if (startIndex > 0 || endIndex < total) {
			this.pickerContainer.addChild(new Text(
				this.theme.scrollInfo(`  (${this.selectedIndex + 1}/${total})`),
				0, 0,
			));
		}
	}

	// ── State transitions ───────────────────────────────────────

	private setMode(mode: EditorMode): void {
		this.mode = mode;
		if (mode.kind === "picker") {
			this.searchInput = new Input();
			this.pickerContainer = new Container();
			this.filteredModels = this.allModels;
			this.selectedIndex = 0;
			this._focused = true;
			this.searchInput.focused = true;
		}
		this.rebuild();
	}

	// ── Input handling (same pattern as ModelPickerComponent) ──

	handleInput(data: string): void {
		if (this.mode.kind === "picker") {
			this.handlePickerInput(data);
			return;
		}
		this.handleListInput(data);
	}

	private handleListInput(data: string): void {
		const kb = getKeybindings();

		// Reorder (J/K plain keys FIRST — before navigation, because pi-tui's
		// tui.select.up/down may also bind j/k in vim keybinding mode).
		// `k` = move up, `j` = move down (vim-style, case-insensitive).
		const reorder = reorderDirection(data);
		if (reorder === "up") { this.moveCurrentUp(); return; }
		if (reorder === "down") { this.moveCurrentDown(); return; }

		// Cancel
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel();
			return;
		}

		// Done (save)
		if (kb.matches(data, "tui.select.confirm") || isSingleKey(data, "d")) {
			this.onDone(reassignPriorities(this.items));
			return;
		}

		// Navigation (cursor — arrows only; j/k are taken by reorder)
		if (kb.matches(data, "tui.select.up")) { this.cursorUp(); return; }
		if (kb.matches(data, "tui.select.down")) { this.cursorDown(); return; }

		// Add / Remove (case-insensitive single keys)
		if (isSingleKey(data, "a")) { this.setMode({ kind: "picker" }); return; }
		if (isSingleKey(data, "x")) { this.removeCurrent(); return; }

		// Unhandled — consume nothing
	}

	private handlePickerInput(data: string): void {
		const kb = getKeybindings();

		// Cancel picker → back to list (Esc only; `d` is for list-mode done)
		if (kb.matches(data, "tui.select.cancel")) {
			this.setMode({ kind: "list" });
			return;
		}

		// Confirm selection
		if (kb.matches(data, "tui.select.confirm")) {
			const m = this.filteredModels[this.selectedIndex];
			if (m) {
				this.items = chainEditorAdd(this.items, {
					provider: m.provider,
					model: m.id,
					priority: 0, // will be reassigned on save
				});
				this.cursor = this.items.length - 1;
			}
			this.setMode({ kind: "list" });
			return;
		}

		// Navigation
		if (kb.matches(data, "tui.select.up")) { this.pickerMove(-1); return; }
		if (kb.matches(data, "tui.select.down")) { this.pickerMove(1); return; }
		if (kb.matches(data, "tui.select.pageUp")) { this.pickerMove(-MAX_VISIBLE); return; }
		if (kb.matches(data, "tui.select.pageDown")) { this.pickerMove(MAX_VISIBLE); return; }

		// Forward to search input, then refresh filter
		this.searchInput.handleInput(data);
		this.filterModels(this.searchInput.getValue());
	}

	// ── List mode actions ──────────────────────────────────────

	private cursorUp(): void {
		if (this.cursor > 0) { this.cursor--; this.rebuild(); }
	}

	private cursorDown(): void {
		if (this.cursor < this.items.length - 1) { this.cursor++; this.rebuild(); }
	}

	private removeCurrent(): void {
		const { items, cursor } = chainEditorRemove(this.items, this.cursor);
		this.items = items;
		this.cursor = cursor;
		this.rebuild();
	}

	private moveCurrentUp(): void {
		const { items, cursor } = chainEditorMoveUp(this.items, this.cursor);
		this.items = items;
		this.cursor = cursor;
		this.rebuild();
	}

	private moveCurrentDown(): void {
		const { items, cursor } = chainEditorMoveDown(this.items, this.cursor);
		this.items = items;
		this.cursor = cursor;
		this.rebuild();
	}

	// ── Picker mode navigation ──────────────────────────────────

	private pickerMove(delta: number): void {
		const n = this.filteredModels.length;
		if (n === 0) return;
		this.selectedIndex = (this.selectedIndex + delta + n) % n;
		this.updatePickerList();
	}
}

export function createChainEditor(opts: ChainEditorOptions): ChainEditorComponent {
	return new ChainEditorComponent(opts);
}
