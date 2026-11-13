import type { Meta, StoryObj } from "@storybook/react";
import { DiagnosticsList, EmptyState, ErrorDetail, FreshnessIndicator, InspectorSection, LifecycleRail, Skeleton, StaleDataBanner } from "../components/feedback";
import { Disclosure, EpistemicMarker, InlineMessage, ReadinessBadge, SyntheticPill } from "../components/status";
import { Button } from "../components/controls";

const meta = { title: "Platform/Feedback", component: StaleDataBanner } satisfies Meta<typeof StaleDataBanner>;
export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => undefined;

export const Stale: Story = { args: { lastValidAt: "2026-11-08T14:05:12Z", reason: "bff.upstream_unavailable", onRetry: noop } };

export const Freshness: Story = {
  args: { lastValidAt: null, onRetry: noop },
  render: () => (
    <div style={{ display: "grid", gap: 8 }}>
      <FreshnessIndicator updatedAt="2026-11-08T14:05:12Z" intervalSec={5} onRefresh={noop} />
      <FreshnessIndicator updatedAt="2026-11-08T14:05:12Z" refreshing onRefresh={noop} />
      <FreshnessIndicator updatedAt="2026-11-08T14:05:12Z" stale onRefresh={noop} />
    </div>
  ),
};

export const Readiness: Story = {
  args: { lastValidAt: null, onRetry: noop },
  render: () => <div style={{ display: "flex", gap: 8 }}><ReadinessBadge status="Ready" /><ReadinessBadge status="Degraded" /><ReadinessBadge status="Unavailable" /><ReadinessBadge status="Unknown" /><SyntheticPill /></div>,
};

export const Messages: Story = {
  args: { lastValidAt: null, onRetry: noop },
  render: () => (
    <div style={{ display: "grid", gap: 8, maxWidth: 560 }}>
      <InlineMessage tone="ok">Recorded. Receipt <code>dec_7c1e</code>.</InlineMessage>
      <InlineMessage tone="warn">Recorded. Waiting for 1 more independent approval.</InlineMessage>
      <InlineMessage tone="error">The decision was not recorded.</InlineMessage>
    </div>
  ),
};

export const Disclosures: Story = {
  args: { lastValidAt: null, onRetry: noop },
  render: () => (
    <div style={{ display: "grid", gap: 8, maxWidth: 560 }}>
      <Disclosure title="Missing telemetry." >3 spans sampled out — the ledger is complete.</Disclosure>
      <Disclosure tone="attention" title="Missing context" code="CONTEXT_MISSING">OwnershipInterest.voting_interest</Disclosure>
      <Disclosure tone="blocking" title="Restricted for purpose." code="ACCESS_DENIED">Connected but not entitled for onboarding.</Disclosure>
      <Disclosure tone="info" title="Historical reconstruction">Read only.</Disclosure>
    </div>
  ),
};

export const Epistemic: Story = {
  args: { lastValidAt: null, onRetry: noop },
  render: () => (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      {(["observation", "assertion", "claim", "fact", "hypothesis", "assumption", "finding", "recommendation", "decision"] as const).map((kind) => <EpistemicMarker key={kind} kind={kind} />)}
    </div>
  ),
};

export const Lifecycle: Story = {
  args: { lastValidAt: null, onRetry: noop },
  render: () => (
    <div style={{ display: "grid", gap: 24, maxWidth: 720 }}>
      <LifecycleRail current="DRAFT" />
      <LifecycleRail current="EVALUATED" events={[
        { stage: "DRAFT", actor: "a.author", at: "2026-11-07T09:00:00Z" },
        { stage: "COMPILED", actor: "a.author", at: "2026-11-07T09:12:00Z" },
        { stage: "EVALUATED", actor: "a.author", at: "2026-11-07T09:20:00Z" },
      ]} />
      <LifecycleRail current="PUBLISHED" />
    </div>
  ),
};

export const Diagnostics: Story = {
  args: { lastValidAt: null, onRetry: noop },
  render: () => (
    <DiagnosticsList onSelectPath={noop} diagnostics={[
      { code: "author.graph_cycle", severity: "error", path: "workflow.spec.nodes.3", message: "The workflow has a cycle through screen → enrich → screen." },
      { code: "author.binding_capability_external", severity: "warning", path: "package.bindings.screen", message: "Capability is bound outside this package." },
      { code: "compiler.model_profile_missing", severity: "info", path: "package.modelProfiles.0", message: "Model profile model.deep.v1 is not configured." },
    ]} />
  ),
};

export const Errors: Story = {
  args: { lastValidAt: null, onRetry: noop },
  render: () => (
    <div style={{ display: "grid", gap: 12, maxWidth: 560 }}>
      <ErrorDetail error={{ error: "workflow.human_decision_not_assigned", message: "Claimed by A. Ruiz. Claim it too, or ask them.", status: 409, correlationId: "c-7f3a", details: { assignees: ["a.ruiz"] } }} action={<Button size="sm">Claim to decide</Button>} />
      <ErrorDetail error={{ error: "authorization.separation_of_duties", message: "You authored or compiled this, so someone else must approve it.", status: 403 }} />
    </div>
  ),
};

export const Sections: Story = {
  args: { lastValidAt: null, onRetry: noop },
  render: () => (
    <div style={{ display: "grid", gap: 8, maxWidth: 420 }}>
      <InspectorSection title="Input schema" description="3 required fields" count={3} defaultOpen><p>Schema body</p></InspectorSection>
      <InspectorSection title="Case writes" count={0}><p>None</p></InspectorSection>
    </div>
  ),
};

export const Empty: Story = { args: { lastValidAt: null, onRetry: noop }, render: () => <EmptyState title="No admitted plans" action={<Button variant="primary">Admit plan</Button>}>Admit a compiled plan to run it here. Source YAML is not accepted.</EmptyState> };

export const Loading: Story = { args: { lastValidAt: null, onRetry: noop }, render: () => <Skeleton height={120} label="Loading runs" /> };
