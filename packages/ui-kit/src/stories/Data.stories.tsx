import type { Meta, StoryObj } from "@storybook/react";
import { DigestValue, Id, JsonViewer, LocalTimestamp, Table } from "../components/data";

const meta = { title: "Primitives/Data", component: DigestValue } satisfies Meta<typeof DigestValue>;
export default meta;
type Story = StoryObj<typeof meta>;

const DIGEST = "sha256:9c41aa77e07b3f1d2c8e5a6b7d9f0e1c2b3a4d5e6f708192a3b4c5d6e7f8e07b";

export const DigestTruncated: Story = { args: { value: DIGEST, label: "plan digest" } };
export const DigestFull: Story = { args: { value: DIGEST, label: "plan digest", full: true } };
export const DigestMissing: Story = { args: { value: null } };

export const Identifiers: Story = { args: { value: DIGEST }, render: () => <span style={{ display: "flex", gap: 8 }}><Id>KYB-1042</Id><Id>wi_own_review</Id><Id>ownership.ubo.resolve</Id></span> };

export const Timestamps: Story = {
  args: { value: DIGEST },
  render: () => (
    <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 16px", margin: 0 }}>
      <dt>Default</dt><dd style={{ margin: 0 }}><LocalTimestamp iso="2026-11-08T14:05:12Z" /></dd>
      <dt>Compact</dt><dd style={{ margin: 0 }}><LocalTimestamp iso="2026-11-08T14:05:12Z" compact /></dd>
      <dt>Missing</dt><dd style={{ margin: 0 }}><LocalTimestamp iso={null} /></dd>
      <dt>Unparseable</dt><dd style={{ margin: 0 }}><LocalTimestamp iso="yesterday-ish" /></dd>
    </dl>
  ),
};

export const Json: Story = {
  args: { value: DIGEST },
  render: () => <JsonViewer label="Command payload" data={{ commandType: "ResolveContradiction", payload: { contradictionId: "cf-12", resolution: "registry_authoritative", note: "Registry filing dated after the declaration supersedes it; declared 25% vs registered 15% beneficial interest." } }} />,
};

type Row = { runId: string; status: string; cost: string };
const rows: Row[] = [
  { runId: "run_completed_0001", status: "completed", cost: "$0.0123" },
  { runId: "run_failed_0003_with_a_long_identifier", status: "failed", cost: "$0.0050 (incomplete)" },
];
export const DataTable: Story = {
  args: { value: DIGEST },
  render: () => (
    <div style={{ maxWidth: 420 }}>
      <Table caption="Runs" columns={[
        { key: "run", header: "Run", render: (row: Row) => <Id>{row.runId}</Id> },
        { key: "status", header: "Status", render: (row: Row) => row.status },
        { key: "cost", header: "Reported cost", align: "end", render: (row: Row) => row.cost },
      ]} rows={rows} rowKey={(row) => row.runId} stickyFirstColumn />
    </div>
  ),
};
export const EmptyTable: Story = {
  args: { value: DIGEST },
  render: () => <Table caption="Runs" captionHidden columns={[{ key: "run", header: "Run", render: (row: Row) => row.runId }]} rows={[]} rowKey={(row) => row.runId} empty="No runs match these filters." />,
};
