// Generated once from tokens.json stateMap: one story per dimension, every value shown.
import type { Meta, StoryObj } from "@storybook/react";
import { StatusBadge } from "../components/status";
import { StateRow } from "./state-row";

const meta = { title: "Status/StatusBadge", component: StatusBadge } satisfies Meta<typeof StatusBadge>;
export default meta;
type Story = StoryObj<typeof meta>;

export const UnknownValue: Story = { args: { dimension: "RunStatus", value: "teleported", showDimension: true } };
export const NotReported: Story = { args: { dimension: "RunStatus", value: null, showDimension: true } };

export const SkillStatus: Story = { args: { dimension: "SkillStatus", value: null }, render: () => <StateRow dimension="SkillStatus" /> };
export const TaskStatus: Story = { args: { dimension: "TaskStatus", value: null }, render: () => <StateRow dimension="TaskStatus" /> };
export const CaseState: Story = { args: { dimension: "CaseState", value: null }, render: () => <StateRow dimension="CaseState" /> };
export const Disposition: Story = { args: { dimension: "Disposition", value: null }, render: () => <StateRow dimension="Disposition" /> };
export const ApprovalStatus: Story = { args: { dimension: "ApprovalStatus", value: null }, render: () => <StateRow dimension="ApprovalStatus" /> };
export const Outcome: Story = { args: { dimension: "Outcome", value: null }, render: () => <StateRow dimension="Outcome" /> };
export const VerificationStatus: Story = { args: { dimension: "VerificationStatus", value: null }, render: () => <StateRow dimension="VerificationStatus" /> };
export const FindingStatus: Story = { args: { dimension: "FindingStatus", value: null }, render: () => <StateRow dimension="FindingStatus" /> };
export const HypothesisStatus: Story = { args: { dimension: "HypothesisStatus", value: null }, render: () => <StateRow dimension="HypothesisStatus" /> };
export const ConflictStatus: Story = { args: { dimension: "ConflictStatus", value: null }, render: () => <StateRow dimension="ConflictStatus" /> };
export const MediaStatus: Story = { args: { dimension: "MediaStatus", value: null }, render: () => <StateRow dimension="MediaStatus" /> };
export const Severity: Story = { args: { dimension: "Severity", value: null }, render: () => <StateRow dimension="Severity" /> };
export const EffectMode: Story = { args: { dimension: "EffectMode", value: null }, render: () => <StateRow dimension="EffectMode" /> };
export const Maturity: Story = { args: { dimension: "Maturity", value: null }, render: () => <StateRow dimension="Maturity" /> };
export const WorkItemStatus: Story = { args: { dimension: "WorkItemStatus", value: null }, render: () => <StateRow dimension="WorkItemStatus" /> };
export const RunStatus: Story = { args: { dimension: "RunStatus", value: null }, render: () => <StateRow dimension="RunStatus" /> };
export const KycCaseStatus: Story = { args: { dimension: "KycCaseStatus", value: null }, render: () => <StateRow dimension="KycCaseStatus" /> };
export const ReleaseStatus: Story = { args: { dimension: "ReleaseStatus", value: null }, render: () => <StateRow dimension="ReleaseStatus" /> };
export const AuthoringStatus: Story = { args: { dimension: "AuthoringStatus", value: null }, render: () => <StateRow dimension="AuthoringStatus" /> };
export const PolicyDecision: Story = { args: { dimension: "PolicyDecision", value: null }, render: () => <StateRow dimension="PolicyDecision" /> };
export const CommandOutcome: Story = { args: { dimension: "CommandOutcome", value: null }, render: () => <StateRow dimension="CommandOutcome" /> };
export const HumanDecision: Story = { args: { dimension: "HumanDecision", value: null }, render: () => <StateRow dimension="HumanDecision" /> };
export const ContextReadiness: Story = { args: { dimension: "ContextReadiness", value: null }, render: () => <StateRow dimension="ContextReadiness" /> };
