import { describe, it, expect, vi } from "vitest";
import {
	DECISION_API_TYPE,
	DECISION_MIN_JUDGE_TIMEOUT_MS,
	isDecisionApi,
	judgeApiUrl,
	buildDecisionRequestBody,
	parseDecisionResponse,
	resolvedModelOf,
} from "../src/judge.js";
import type { ProviderEndpoint } from "../src/types.js";

const endpoint: ProviderEndpoint = {
	provider: "typesafe",
	modelId: "jev-1.13.0",
	baseUrl: "https://api.typesafe.ai/",
	apiType: DECISION_API_TYPE,
	apiKey: "tsk-test",
};

describe("decision protocol — request shape (SPEC §8.6)", () => {
	it("recognizes the decision api type", () => {
		expect(isDecisionApi(DECISION_API_TYPE)).toBe(true);
		expect(isDecisionApi("openai-completions")).toBe(false);
		expect(isDecisionApi("anthropic-messages")).toBe(false);
	});

	it("posts to /v1/systemone and trims a trailing slash", () => {
		expect(judgeApiUrl("https://api.typesafe.ai/", DECISION_API_TYPE)).toBe(
			"https://api.typesafe.ai/v1/systemone",
		);
		expect(judgeApiUrl("https://gw.example/decisions/", DECISION_API_TYPE)).toBe(
			"https://gw.example/decisions/v1/systemone",
		);
	});

	it("builds Choice(tier) + Noul(orchestrate) questions with the state = prompt", () => {
		const body: any = buildDecisionRequestBody(endpoint, "user: fix the bug");
		expect(body.model).toBe("jev-1.13.0");
		expect(body.state).toBe("user: fix the bug");
		expect(body.questions.tier.type).toBe("choice");
		expect(body.questions.tier.criteria).toEqual({ fast: expect.any(String), smart: expect.any(String) });
		expect(typeof body.questions.tier.instructions).toBe("string");
		expect(body.questions.orchestrate.type).toBe("noul");
		expect(typeof body.questions.orchestrate.instructions).toBe("string");
	});
});

describe("decision protocol — response mapping", () => {
	const tier = (choice: string, probabilities: Record<string, number>, extra: object = {}) => ({
		choice,
		probabilities,
		...extra,
	});

	it("maps an `answers` envelope (choice + probabilities + noul)", () => {
		const raw = {
			answers: {
				tier: tier("smart", { fast: 0.2, smart: 0.8 }),
				orchestrate: { noul: 0.9 },
			},
		};
		expect(parseDecisionResponse(raw)).toEqual({ tier: "smart", confidence: 0.8, orchestrate: true });
	});

	it("maps a bare top-level map (gateway variants)", () => {
		const raw = {
			tier: tier("fast", { fast: 0.95, smart: 0.05 }),
			orchestrate: { noul: 0.1 },
		};
		expect(parseDecisionResponse(raw)).toEqual({ tier: "fast", confidence: 0.95, orchestrate: false });
	});

	it("falls back to the confidence field when probabilities are absent", () => {
		const raw = { answers: { tier: { choice: "smart", confidence: 0.66 }, orchestrate: { noul: 0.5 } } };
		expect(parseDecisionResponse(raw)).toEqual({ tier: "smart", confidence: 0.66, orchestrate: true });
	});

	it("leaves orchestrate undefined when the noul answer is missing (no fabrication)", () => {
		const raw = { answers: { tier: tier("fast", { fast: 0.9, smart: 0.1 }) } };
		expect(parseDecisionResponse(raw)).toEqual({ tier: "fast", confidence: 0.9 });
	});

	it("holds (null) when the choice is not a declared tier", () => {
		expect(parseDecisionResponse({ answers: { tier: tier("maybe", { fast: 0.5, smart: 0.5 }) } })).toBeNull();
	});

	it("holds (null) when there is no tier answer at all", () => {
		expect(parseDecisionResponse({ answers: { orchestrate: { noul: 1 } } })).toBeNull();
		expect(parseDecisionResponse({} as any)).toBeNull();
	});

	it("applies the 0.5 noul threshold at the boundary", () => {
		const withNoul = (noul: number) => ({ answers: { tier: tier("fast", { fast: 0.9, smart: 0.1 }), orchestrate: { noul } } });
		expect(parseDecisionResponse(withNoul(0.49))!.orchestrate).toBe(false);
		expect(parseDecisionResponse(withNoul(0.5))!.orchestrate).toBe(true);
		expect(parseDecisionResponse(withNoul(0.51))!.orchestrate).toBe(true);
	});

	it("accepts a bare numeric noul answer too", () => {
		const raw = { answers: { tier: tier("fast", { fast: 0.9, smart: 0.1 }), orchestrate: 0.7 } };
		expect(parseDecisionResponse(raw)!.orchestrate).toBe(true);
	});
});

describe("resolvedModelOf — alias moves stay visible", () => {
  it("reads the version the endpoint says answered (alias request)", () => {
    // Asked for jev-latest, answered with a version: this is the signal that the
    // distribution behind θ may have moved.
    expect(resolvedModelOf({ model: "jev-1.13.0", answers: {} })).toBe("jev-1.13.0");
  });

  it("returns undefined when the body carries no model id", () => {
    expect(resolvedModelOf({ answers: {} })).toBeUndefined();
    expect(resolvedModelOf({ model: "" })).toBeUndefined();
    expect(resolvedModelOf({ model: 42 as any })).toBeUndefined();
  });
});
