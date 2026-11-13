import { describe, expect, it } from "vitest";
import { F64, formatF64, parseJson, stringify, stringifyPretty } from "./json.js";
import { parseYaml, toJson } from "./yaml.js";

describe("float text", () => {
  it.each([
    [1, "1.0"], [0.1, "0.1"], [1e21, "1e+21"], [1e-7, "1e-7"], [123456789012345678, "1.2345678901234568e+17"],
    [1.5e300, "1.5e+300"], [5e-324, "5e-324"], [0.000001, "1e-6"], [1e16, "1e+16"], [1e15, "1000000000000000.0"],
    [12345678.9, "12345678.9"], [-0, "-0.0"], [0, "0.0"], [2.5e-5, "0.000025"], [1e-5, "0.00001"], [0.0001, "0.0001"],
    [1000, "1000.0"], [-1.5, "-1.5"], [0.85, "0.85"],
  ])("%s is written as %s", (value, text) => {
    expect(formatF64(value)).toBe(text);
  });
});

describe("JSON", () => {
  it("keeps integer and float syntax apart when parsing", () => {
    const value = parseJson('{"a": 1.0, "b": 2, "c": 18446744073709551615, "d": 1e2, "e": -3}');
    expect(stringify(value)).toBe('{"a":1.0,"b":2,"c":18446744073709551615,"d":100.0,"e":-3}');
  });

  it("pretty-prints like serde_json", () => {
    expect(stringifyPretty({ b: [], a: {}, c: [1, new F64(2)] })).toBe('{\n  "a": {},\n  "b": [],\n  "c": [\n    1,\n    2.0\n  ]\n}');
  });

  it("treats __proto__ as an ordinary key", () => {
    const value = parseJson('{"__proto__": {"polluted": true}}');
    expect(stringify(value)).toBe('{"__proto__":{"polluted":true}}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("YAML scalars", () => {
  const resolve = (text: string) => {
    const document = parseYaml(`value: ${text}\n`, "test");
    return stringify(toJson(document, document.root));
  };

  it.each([
    ["~", "null"], ["null", "null"], ["Null", "null"], ["", "null"], ["true", "true"], ["True", "true"], ["yes", '"yes"'],
    ["on", '"on"'], ["0x1F", "31"], ["0o17", "15"], ["0b101", "5"], ["007", '"007"'], ["+7", "7"], ["-5", "-5"],
    ["1.0", "1.0"], ["3.", "3.0"], [".5", "0.5"], ["1_0", '"1_0"'], [".inf", "null"], [".nan", "null"], ["'1.0'", '"1.0"'],
    ["2001-01-01", '"2001-01-01"'], ["18446744073709551615", "18446744073709551615"],
  ])("%s resolves to %s", (text, json) => {
    expect(resolve(text)).toBe(`{"value":${json}}`);
  });

  it("refuses tags, duplicate keys and integers wider than 64 bits", () => {
    expect(() => resolve("!!str 5")).toThrow("tags are not supported");
    expect(() => parseYaml("a: 1\na: 2\n", "test")).toThrow("parse test");
    expect(() => resolve("18446744073709551616")).toThrow("integer out of range");
  });
});
