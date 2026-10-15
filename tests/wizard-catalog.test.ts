/**
 * pi-shift-router — wizard model catalog must not block the UI
 *
 * `/router config` froze for seconds before the menu appeared. The cause was
 * not rendering and not disk IO (1.4 ms): the wizard awaited pi's
 * `ModelRegistry.refresh()`, which in pi 1.2.0 runs a full availability pass —
 * a model-list fetch plus an auth check for every provider, measured at
 * 0.19–4.3 s per provider and executed concurrently, so the wait is the slowest
 * provider. `allowNetwork: false` does not skip it.
 *
 * The contract these tests pin down:
 *   1. the catalog is returned immediately — a pending refresh never delays it;
 *   2. the refresh still happens, in the background, and is bounded by a signal;
 *   3. a failing/slow refresh never reaches the caller (errors are values);
 *   4. the on-disk stores are still re-read (the wizard's actual freshness
 *      requirement, which costs ~1.4 ms).
 */

import { describe, it, expect, vi } from "vitest";
import { prepareWizardCatalog, routeConfigWizard } from "../src/commands.js";
import { refreshRegistryInBackground } from "../src/model-source.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import type { AuthStore, ModelsStore } from "../src/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A store/auth pair that does not touch the real ~/.pi/agent files. */
function fakeStores(store: ModelsStore = {}, auth: AuthStore = {}) {
	return { readStores: vi.fn(async () => ({ store, auth })) };
}

/** A promise that never settles — stands in for a refresh stuck on the network. */
const never = () => new Promise<never>(() => {});

describe("prepareWizardCatalog", () => {
	it("returns immediately even when the registry refresh never settles", async () => {
		const refresh = vi.fn(() => never());
		const started = Date.now();

		const catalog = await prepareWizardCatalog(
			{ refresh },
			{ invalidate: () => {}, ...fakeStores() },
		);

		// The regression: this used to wait for the whole availability pass.
		expect(Date.now() - started).toBeLessThan(50);
		expect(catalog.registry).toBeDefined();
		// Still running in the background — it is not swallowed, just not awaited.
		expect(await Promise.race([catalog.refreshing.then(() => "settled"), sleep(10).then(() => "pending")])).toBe("pending");
	});

	it("starts the refresh in the background with a bounding signal", async () => {
		const seen: Array<{ signal?: AbortSignal; allowNetwork?: boolean }> = [];
		const refresh = vi.fn(async (options?: { signal?: AbortSignal; allowNetwork?: boolean }) => {
			seen.push(options ?? {});
			return undefined;
		});

		await prepareWizardCatalog({ refresh }, { invalidate: () => {}, ...fakeStores() });
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
	});

	it("resolves `refreshing` instead of rejecting when the refresh fails", async () => {
		const catalog = await prepareWizardCatalog(
			{ refresh: async () => { throw new Error("provider down"); } },
			{ invalidate: () => {}, ...fakeStores() },
		);
		await expect(catalog.refreshing).resolves.toBeUndefined();
	});

	it("re-reads the stores from disk before handing the catalog over", async () => {
		const order: string[] = [];
		const { readStores } = fakeStores();
		await prepareWizardCatalog(
			{ refresh: async () => {} },
			{
				invalidate: () => order.push("invalidate"),
				readStores: async () => {
					order.push("read");
					return readStores();
				},
			},
		);
		expect(order).toEqual(["invalidate", "read"]);
	});

	it("works without a registry at all", async () => {
		const catalog = await prepareWizardCatalog(undefined, { invalidate: () => {}, ...fakeStores() });
		await expect(catalog.refreshing).resolves.toBeUndefined();
	});
});

describe("refreshRegistryInBackground", () => {
	it("is a no-op without a registry or without refresh()", async () => {
		await expect(refreshRegistryInBackground(undefined, 100)).resolves.toBeUndefined();
		await expect(refreshRegistryInBackground({}, 100)).resolves.toBeUndefined();
	});

	it("bounds the wait — the signal aborts once the timeout elapses", async () => {
		let signal: AbortSignal | undefined;
		await refreshRegistryInBackground(
			{ refresh: async (options?: { signal?: AbortSignal }) => { signal = options?.signal; } },
			30,
		);
		expect(signal?.aborted).toBe(false);
		await sleep(60);
		expect(signal?.aborted).toBe(true);
	});

	it("never rejects, even when the registry throws synchronously", async () => {
		await expect(
			refreshRegistryInBackground({ refresh: () => { throw new Error("boom"); } }, 20),
		).resolves.toBeUndefined();
	});
});

/**
 * The wiring itself, not just the helper: the freeze lived in the wizard's
 * open path, so this pins the order of events there. `ui.custom` is never
 * reached — the first `ui.select` (the menu) is where the wizard used to stall.
 */
describe("routeConfigWizard", () => {
	function fakeCtx(order: string[], refresh: () => Promise<never>) {
		return {
			modelRegistry: { refresh, getAvailable: () => [{ provider: "p", id: "m" }] },
			mode: "tui",
			ui: {
				select: async () => {
					order.push("ui");
					return "🚫 Discard & exit";
				},
				notify: () => {},
				setStatus: () => {},
				custom: () => {},
			},
		} as unknown as Parameters<typeof routeConfigWizard>[2];
	}

	it("shows the menu before the registry refresh settles", async () => {
		const order: string[] = [];
		const refresh = vi.fn(() => {
			order.push("refresh");
			return never();
		});

		const returned = await routeConfigWizard(
			DEFAULT_CONFIG,
			"/tmp",
			fakeCtx(order, refresh),
			{
				invalidate: () => order.push("invalidate"),
				readStores: async () => ({ store: {} as ModelsStore, auth: {} as AuthStore }),
			},
		);

		expect(returned).toBe(false); // “Discard & exit”
		expect(order).toEqual(["invalidate", "refresh", "ui"]);
	});

	it("waits for the refresh only when there is nothing to show yet", async () => {
		const order: string[] = [];
		let models: Array<{ provider: string; id: string }> = [];
		const registry = {
			refresh: async () => {
				order.push("refresh");
				await sleep(20);
				models = [{ provider: "p", id: "m" }];
			},
			getAvailable: () => models,
		};

		const returned = await routeConfigWizard(
			DEFAULT_CONFIG,
			"/tmp",
			{
				modelRegistry: registry,
				mode: "tui",
				ui: {
					select: async () => {
						order.push("ui");
						return "🚫 Discard & exit";
					},
					notify: () => {},
					setStatus: () => {},
					custom: () => {},
				},
			} as unknown as Parameters<typeof routeConfigWizard>[2],
			{
				invalidate: () => {},
				readStores: async () => ({ store: {} as ModelsStore, auth: {} as AuthStore }),
			},
		);

		// Reaching the menu (rather than exiting with “No models found”) proves the
		// wait happened, and that it happened before the UI.
		expect(returned).toBe(false);
		expect(order).toEqual(["refresh", "ui"]);
	});
});
