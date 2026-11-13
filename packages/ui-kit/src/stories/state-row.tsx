import { STATE_MAP, stateTone, type StateDimension } from "@ehf/ui-tokens";
import { StatusBadge } from "../components/status";

/** Every value of one stateMap dimension: raw, humanised and with its dimension label. */
export function StateRow({ dimension }: { dimension: StateDimension }) {
  const values = Object.keys(STATE_MAP[dimension] as Record<string, string>);
  return (
    <table style={{ borderCollapse: "collapse", fontSize: "var(--text-sm)" }}>
      <caption style={{ textAlign: "left", fontWeight: 600, paddingBottom: "var(--space-2)" }}>{dimension}</caption>
      <thead>
        <tr>
          {["Value", "Tone", "Badge", "Humanised", "With dimension"].map((heading) => (
            <th key={heading} scope="col" style={{ textAlign: "left", padding: "4px 12px 4px 0", color: "var(--ink-2)", fontWeight: 500 }}>{heading}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {values.map((value) => (
          <tr key={value}>
            <th scope="row" style={{ textAlign: "left", padding: "4px 12px 4px 0", fontFamily: "var(--font-mono)", fontWeight: 400 }}>{value}</th>
            <td style={{ padding: "4px 12px 4px 0", color: "var(--ink-2)" }}>{stateTone(dimension, value)}</td>
            <td style={{ padding: "4px 12px 4px 0" }}><StatusBadge dimension={dimension} value={value} /></td>
            <td style={{ padding: "4px 12px 4px 0" }}><StatusBadge dimension={dimension} value={value} humanize /></td>
            <td style={{ padding: "4px 12px 4px 0" }}><StatusBadge dimension={dimension} value={value} humanize showDimension /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
