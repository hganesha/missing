import { allStates, GLYPHS_USED } from "@ehf/ui-tokens";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import {
  Button, DiagnosticsList, DigestValue, Disclosure, EpistemicMarker, ErrorDetail, Field, FreshnessIndicator, ICON_PATHS,
  InlineMessage, InspectorSection, JsonViewer, LifecycleRail, LocalTimestamp, ReadinessBadge, SegmentedControl, Sheet,
  StaleDataBanner, StatusBadge, Switch, SyntheticPill, Table, Tabs, TextInput, fmtDigest, fmtLocalTime,
} from "./index";

async function expectNoAxeViolations(container: HTMLElement) {
  // jsdom has no layout, so contrast is checked in Storybook's a11y addon instead.
  const results = await axe.run(container, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
  expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`)).toEqual([]);
}

function TabsHarness() {
  const [value, setValue] = useState<"contract" | "context" | "trace">("contract");
  return (
    <Tabs
      label="Skill inspector"
      value={value}
      onChange={setValue}
      items={[{ value: "contract", label: "Contract" }, { value: "context", label: "Context", count: 3 }, { value: "trace", label: "Trace" }]}
      renderPanel={(selected) => <p>Panel {selected}</p>}
    />
  );
}

function SegmentedHarness() {
  const [value, setValue] = useState<"play" | "tune" | "engineer">("play");
  return <SegmentedControl label="Mode" value={value} onChange={setValue} options={[{ value: "play", label: "Play" }, { value: "tune", label: "Tune" }, { value: "engineer", label: "Engineer" }]} />;
}

function SheetHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open sheet</Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Record decision" footer={<Button variant="primary">Save</Button>}>
        <Field label="Rationale"><TextInput /></Field>
      </Sheet>
    </>
  );
}

describe("Tabs", () => {
  it("moves selection with arrows, Home and End and keeps one tab in the tab order", async () => {
    const user = userEvent.setup();
    render(<TabsHarness />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    await user.click(tabs[0]!);
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: /Context/ })).toHaveFocus();
    expect(screen.getByRole("tab", { name: /Context/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Panel context");
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Trace" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Contract" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Trace" })).toHaveFocus();
  });
});

describe("SegmentedControl", () => {
  it("is a radio group that selects with arrow keys", async () => {
    const user = userEvent.setup();
    render(<SegmentedHarness />);
    const play = screen.getByRole("radio", { name: "Play" });
    expect(play).toHaveAttribute("aria-checked", "true");
    await user.click(play);
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Tune" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Tune" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("radio", { name: "Engineer" })).toHaveAttribute("aria-checked", "true");
  });
});

describe("Sheet", () => {
  it("moves focus in, traps Tab, closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<SheetHarness />);
    const trigger = screen.getByRole("button", { name: "Open sheet" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Record decision" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const close = screen.getByRole("button", { name: "Close" });
    expect(close).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("textbox", { name: "Rationale" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });
});

describe("DigestValue and formatting", () => {
  it("truncates digests longer than 22 characters to first15…last6 and keeps the full value", () => {
    const digest = "sha256:9c41aa77e07b3f1d2c8e5a6b7d9f0e1c2b3a4d5e6f708192a3b4c5d6e7f8e07b";
    expect(fmtDigest(digest)).toBe(`${digest.slice(0, 15)}…${digest.slice(-6)}`);
    expect(fmtDigest("short-digest")).toBe("short-digest");
    render(<DigestValue value={digest} label="plan digest" />);
    expect(screen.getByTitle(digest)).toHaveTextContent(`${digest.slice(0, 15)}…${digest.slice(-6)}`);
    expect(screen.getByRole("button", { name: "Copy plan digest" })).toBeInTheDocument();
  });

  it("formats local time compactly and offers UTC on hover", () => {
    const iso = "2026-11-08T14:05:12.000Z";
    const date = new Date(iso);
    const pad = (value: number) => String(value).padStart(2, "0");
    expect(fmtLocalTime(iso, true)).toBe(`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`);
    expect(fmtLocalTime("not a date")).toBeNull();
    render(<LocalTimestamp iso={iso} compact />);
    const time = screen.getByText(fmtLocalTime(iso, true)!);
    expect(time.tagName).toBe("TIME");
    expect(time).toHaveAttribute("title", "2026-11-08 14:05:12 UTC");
    expect(time).toHaveAttribute("datetime", iso);
  });

  it('shows "Never" when a timestamp is absent', () => {
    render(<LocalTimestamp iso={null} />);
    expect(screen.getByText("Never")).toBeInTheDocument();
  });
});

describe("StatusBadge", () => {
  it("always renders text for every state in the stateMap (never colour alone)", () => {
    for (const { dimension, value } of allStates()) {
      const { container, unmount } = render(<StatusBadge dimension={dimension} value={value} />);
      expect(container.textContent?.trim(), `${dimension}.${value}`).toContain(value);
      unmount();
    }
  });

  it("names its dimension when asked", () => {
    render(<StatusBadge dimension="WorkItemStatus" value="WAITING_HUMAN" showDimension humanize />);
    expect(screen.getByText("Work item status")).toBeInTheDocument();
    expect(screen.getByText("Awaiting human review")).toBeInTheDocument();
  });

  it("marks unknown values instead of guessing", () => {
    const { container } = render(<StatusBadge dimension="RunStatus" value="teleported" />);
    expect(screen.getByText("unknown value")).toBeInTheDocument();
    expect(container.querySelector("[data-tone]")).toHaveAttribute("data-tone", "neutral");
  });

  it('says "Not reported" for a missing value', () => {
    render(<StatusBadge dimension="RunStatus" value={null} />);
    expect(screen.getByText("Not reported")).toBeInTheDocument();
  });
});

describe("icons", () => {
  it("has a sprite entry for every glyph stateGlyph can return", () => {
    expect(GLYPHS_USED.filter((glyph) => !(glyph in ICON_PATHS))).toEqual([]);
  });
});

describe("no colour literals", () => {
  // vitest runs from the package directory; import.meta.url is a Vite path under jsdom.
  const root = join(process.cwd(), "src") + "/";
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });

  it("uses token variables only in ui-kit styles and components", () => {
    const offenders: string[] = [];
    for (const file of files(root).filter((path) => /\.(css|tsx?)$/.test(path) && !path.endsWith(".test.tsx"))) {
      const text = readFileSync(file, "utf8");
      const literal = /#[0-9a-f]{3,8}\b(?![-\w])|\brgba?\(|\bhsla?\(|\boklch\(/gi;
      for (const match of text.matchAll(literal)) offenders.push(`${file.replace(root, "")}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it("exports no trusted button from the main entry", async () => {
    const entry = await import("./index");
    expect(Object.keys(entry)).not.toContain("TrustedButton");
  });
});

describe("accessibility (axe, jsdom)", () => {
  it("has no violations across rendered components", async () => {
    const { container } = render(
      <main>
        <Button variant="primary">Save</Button>
        <Button icon="refresh" aria-label="Refresh" />
        <SegmentedHarness />
        <TabsHarness />
        <Switch label="Include drafts" checked={false} onChange={() => undefined} />
        <Field label="Reason code" hint="Up to 200 characters" error="Required"><TextInput /></Field>
        <StatusBadge dimension="PolicyDecision" value="UNKNOWN" showDimension />
        <ReadinessBadge status="Degraded" />
        <SyntheticPill />
        <EpistemicMarker kind="assumption" />
        <Disclosure tone="attention" title="Missing context" code="CONTEXT_MISSING">Voting interest not available.</Disclosure>
        <InlineMessage tone="warn">Waiting for a second approver.</InlineMessage>
        <StaleDataBanner lastValidAt="2026-11-08T14:05:12Z" reason="bff.upstream_unavailable" onRetry={() => undefined} />
        <FreshnessIndicator updatedAt="2026-11-08T14:05:12Z" intervalSec={5} onRefresh={() => undefined} />
        <LifecycleRail current="EVALUATED" events={[{ stage: "DRAFT", actor: "A. Author", at: "2026-11-07T10:00:00Z" }]} />
        <DiagnosticsList diagnostics={[{ code: "author.graph_cycle", severity: "error", path: "workflow.spec.nodes.2", message: "Cycle" }]} onSelectPath={() => undefined} />
        <ErrorDetail error={{ error: "workflow.human_decision_not_assigned", message: "Claim it first.", status: 409, correlationId: "c-1", details: { assignees: ["a.ruiz"] } }} />
        <InspectorSection title="Schemas" count={2}><p>Body</p></InspectorSection>
        <JsonViewer data={{ ok: true }} label="Payload" />
        <DigestValue value="sha256:9c41aa77e07b3f1d2c8e5a6b7d9f0e1c2b3a4d5e6f708192" />
        <Table
          caption="Runs"
          columns={[{ key: "id", header: "Run", render: (row: { id: string }) => row.id }, { key: "cost", header: "Cost", align: "end", render: () => "$0.0100" }]}
          rows={[{ id: "run_1" }]}
          rowKey={(row) => row.id}
          stickyFirstColumn
        />
      </main>,
    );
    await expectNoAxeViolations(container);
  });
});
