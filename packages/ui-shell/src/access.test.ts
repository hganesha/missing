import { describe, expect, it } from "vitest";
import { canUse, landingRoute } from "./access";

const session = (actions: string[], authoringEnabled = true) => ({ actions, authoringEnabled });

describe("canUse", () => {
  it("allows when any required action is held", () => {
    expect(canUse(session(["run.read"]), ["run.read", "plan.read"])).toBe(true);
    expect(canUse(session(["case.read"]), ["run.read"])).toBe(false);
    expect(canUse(session([]), [])).toBe(true);
  });

  it("hides authoring surfaces when authoring is disabled", () => {
    expect(canUse(session(["draft.read"], false), ["draft.read"], true)).toBe(false);
  });
});

describe("landingRoute", () => {
  const all = () => true;
  it.each([
    [["human_work.decide", "case.read"], "/work"],
    [["draft.write", "draft.read"], "/studio/drafts"],
    [["draft.approve", "draft.read", "event.read"], "/studio/drafts"],
    [["admin.read", "admin.write"], "/platform/admin"],
    [["event.read", "case.read"], "/assurance"],
    [["run.read"], "/platform"],
  ])("%j lands on %s", (actions, path) => {
    expect(landingRoute(session(actions), all)).toBe(path);
  });

  it("skips routes the app does not have", () => {
    expect(landingRoute(session(["human_work.decide"]), (path) => path !== "/work")).toBe("/platform");
  });
});
