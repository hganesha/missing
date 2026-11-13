import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { Button } from "../components/controls";
import { Field, Select, TextArea, TextInput } from "../components/form";
import { Sheet, Tooltip } from "../components/overlay";

const meta = { title: "Primitives/Overlay and forms", component: Sheet } satisfies Meta<typeof Sheet>;
export default meta;
type Story = StoryObj<typeof meta>;

function SheetDemo({ initiallyOpen }: { initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open sheet</Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Resolve contradiction cf-12" description="This is a business command (L1), not an approval."
        footer={<><Button variant="quiet" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary">Preview command</Button></>}>
        <Field label="Resolution"><Select defaultValue="registry"><option value="registry">Registry is authoritative</option><option value="declaration">Declaration is authoritative</option></Select></Field>
        <Field label="Note" hint="Shown in the case history"><TextArea defaultValue="Registry filing postdates the declaration." /></Field>
      </Sheet>
    </>
  );
}

export const SheetClosed: Story = { args: { open: false, onClose: () => undefined, title: "", children: null }, render: () => <SheetDemo initiallyOpen={false} /> };
export const SheetOpen: Story = { args: { open: true, onClose: () => undefined, title: "", children: null }, render: () => <SheetDemo initiallyOpen /> };

export const Fields: Story = {
  args: { open: false, onClose: () => undefined, title: "", children: null },
  render: () => (
    <div style={{ display: "grid", gap: 16, maxWidth: 360 }}>
      <Field label="Reason code" hint="Up to 200 characters"><TextInput mono defaultValue="evidence.sufficient" /></Field>
      <Field label="Rationale" error="Explain the decision"><TextArea /></Field>
      <Field label="Disabled"><TextInput disabled defaultValue="read only" /></Field>
    </div>
  ),
};

export const TooltipSupplementary: Story = {
  args: { open: false, onClose: () => undefined, title: "", children: null },
  render: () => <div style={{ paddingTop: 48 }}><Tooltip content="Requires a process flow approver"><Button disabled aria-disabled>Approve</Button></Tooltip></div>,
};
