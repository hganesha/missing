import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allStates, effectTier, isKnownState, STATE_DIMENSIONS, stateGlyph, stateTone, TONES } from "./index.js";

const generatedCss = readFileSync(new URL("./generated/tokens.css", import.meta.url), "utf8");
const referenceCss = readFileSync(new URL("../vendor/reference-tokens.css", import.meta.url), "utf8");

describe("tokens.css", () => {
  it("defines every variable the reference tokens.css defines", () => {
    const names = (css: string) => new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
    const missing = [...names(referenceCss)].filter((name) => !names(generatedCss).has(name));
    expect(missing).toEqual([]);
  });

  it("includes compact density, reduced motion and high contrast modes", () => {
    expect(generatedCss).toContain('[data-density="compact"]');
    expect(generatedCss).toContain("--row-h: 32px");
    expect(generatedCss).toContain("--lh-md: var(--lh-sm)");
    expect(generatedCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(generatedCss).toContain("@media (prefers-contrast: more)");
  });

  it("self-hosts the three OFL font families", () => {
    for (const family of ["Instrument Sans", "Instrument Serif", "JetBrains Mono"]) {
      expect(generatedCss).toContain(`font-family: "${family}"`);
    }
    expect(generatedCss).not.toMatch(/https?:\/\//);
  });
});

describe("stateTone", () => {
  it("maps every stateMap value to a known tone", () => {
    for (const { dimension, value } of allStates()) {
      expect(TONES, `${dimension}.${value}`).toContain(stateTone(dimension, value));
    }
  });

  it("never rounds unknown, review, missing or unverified states up to positive", () => {
    const notPositive: Array<[string, string]> = [
      ["Outcome", "UNKNOWN"], ["VerificationStatus", "UNKNOWN"], ["VerificationStatus", "UNVERIFIED"],
      ["PolicyDecision", "UNKNOWN"], ["PolicyDecision", "REVIEW"], ["CaseState", "REVIEW"],
      ["MediaStatus", "UNKNOWN"], ["Severity", "UNKNOWN"], ["FindingStatus", "UNVERIFIED"],
      ["ContextReadiness", "gaps"], ["ContextReadiness", "not_subscribed"],
    ];
    for (const [dimension, value] of notPositive) expect(stateTone(dimension, value), `${dimension}.${value}`).not.toBe("positive");
    for (const { dimension, value } of allStates()) {
      if (/UNKNOWN|REVIEW|UNVERIFIED|MISSING|PENDING/i.test(value)) expect(stateTone(dimension, value), `${dimension}.${value}`).not.toBe("positive");
    }
  });

  it("treats unknown dimensions, unknown values and missing values as neutral", () => {
    expect(stateTone("NoSuchDimension", "COMPLETED")).toBe("neutral");
    expect(stateTone("RunStatus", "teleported")).toBe("neutral");
    expect(stateTone("RunStatus", null)).toBe("neutral");
    expect(stateTone("RunStatus", undefined)).toBe("neutral");
    expect(isKnownState("RunStatus", "teleported")).toBe(false);
    expect(stateGlyph("RunStatus", "teleported")).toBe("help");
  });

  it("shows DECLINED as a neutral decision with its own glyph", () => {
    expect(stateTone("KycCaseStatus", "DECLINED")).toBe("neutral");
    expect(stateGlyph("KycCaseStatus", "DECLINED")).toBe("gavel");
  });

  it("keeps human decisions neutral and tells them apart by glyph", () => {
    const values = ["APPROVE", "REJECT", "RETURN"];
    for (const value of values) expect(stateTone("HumanDecision", value)).toBe("neutral");
    expect(new Set(values.map((value) => stateGlyph("HumanDecision", value))).size).toBe(values.length);
  });

  it("marks waiting-for-human work with the hand glyph", () => {
    expect(stateTone("WorkItemStatus", "WAITING_HUMAN")).toBe("attention");
    expect(stateGlyph("WorkItemStatus", "WAITING_HUMAN")).toBe("hand");
  });

  it("reads EffectMode as autonomy tiers", () => {
    expect(effectTier("human_gated")).toBe("L2|L3 (policy)");
    expect(stateTone("EffectMode", "external_write")).toBe("blocking");
  });

  it("covers every dimension in tokens.json", () => {
    expect(STATE_DIMENSIONS).toHaveLength(23);
  });
});
