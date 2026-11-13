import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { Button, Chip, SegmentedControl, Switch } from "../components/controls";
import { Tabs } from "../components/Tabs";

const meta = { title: "Primitives/Controls", component: Button } satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = { args: { variant: "primary", children: "Record review outcome" } };
export const Secondary: Story = { args: { variant: "secondary", children: "Preview impact" } };
export const Quiet: Story = { args: { variant: "quiet", children: "Cancel" } };
export const Small: Story = { args: { size: "sm", icon: "refresh", children: "Retry now" } };
export const Disabled: Story = { args: { disabled: true, children: "Approve", title: "Requires a process flow approver" } };
export const Busy: Story = { args: { variant: "primary", busy: true, children: "Committing…" } };
export const IconOnly: Story = { args: { icon: "refresh", "aria-label": "Refresh now" } };

function SegmentedDemo() {
  const [mode, setMode] = useState<"play" | "tune" | "engineer">("play");
  const [binding, setBinding] = useState<"required" | "conditional" | "optional" | "off">("conditional");
  return (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
      <SegmentedControl label="Mode" value={mode} onChange={setMode} options={[{ value: "play", label: "Play" }, { value: "tune", label: "Tune" }, { value: "engineer", label: "Engineer" }]} />
      <SegmentedControl label="Assignment" size="sm" value={binding} onChange={setBinding} options={[{ value: "required", label: "Required" }, { value: "conditional", label: "Conditional" }, { value: "optional", label: "Optional" }, { value: "off", label: "Off", disabled: true }]} />
    </div>
  );
}
export const Segmented: Story = { args: { children: "" }, render: () => <SegmentedDemo /> };

function TabsDemo() {
  const [tab, setTab] = useState<"contract" | "context" | "dependencies" | "trace">("contract");
  return (
    <Tabs
      label="Skill inspector"
      value={tab}
      onChange={setTab}
      items={[{ value: "contract", label: "Contract" }, { value: "context", label: "Context", count: 4 }, { value: "dependencies", label: "Dependencies" }, { value: "trace", label: "Trace" }]}
      renderPanel={(selected) => <p>Selected panel: {selected}</p>}
    />
  );
}
export const TabsKeyboard: Story = { args: { children: "" }, render: () => <TabsDemo /> };

function SwitchDemo() {
  const [on, setOn] = useState(true);
  return <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}><Switch label="Include in draft" checked={on} onChange={setOn} /> Draft configuration only — never execution state</span>;
}
export const SwitchDraftOnly: Story = { args: { children: "" }, render: () => <SwitchDemo /> };

export const Chips: Story = {
  args: { children: "" },
  render: () => (
    <div style={{ display: "flex", gap: 8 }}>
      <Chip>Financial crime</Chip>
      <Chip outline>CDD · you</Chip>
      <Chip onRemove={() => undefined} removeLabel="Remove filter status=failed">status=failed</Chip>
    </div>
  ),
};
