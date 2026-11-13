import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { fmtDigest, fmtLocalTime, fmtUtc } from "../format";
import { CopyButton } from "./controls";
import styles from "./data.module.css";

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

/** An identifier. Always mono and never truncated mid-segment. */
export function Id({ children }: { children: string }) {
  return <code className={styles.id}>{children}</code>;
}

/** Digest with truncation (`first15…last6`), the full value on hover, and copy (ui-specs §2.2). */
export function DigestValue({ value, label = "digest", full = false, copy = true }: { value: string | null | undefined; label?: string; full?: boolean; copy?: boolean }) {
  if (!value) return <span className={styles.none}>—</span>;
  return (
    <span className={styles.digest}>
      <code className={styles.digestText} title={value}>{fmtDigest(value, full)}</code>
      {copy ? <CopyButton value={value} label={label} /> : null}
    </span>
  );
}

/** Local time with the full UTC value in a tooltip; "Never" when absent (ui-specs §2.2). */
export function LocalTimestamp({ iso, compact = false }: { iso: string | null | undefined; compact?: boolean }) {
  if (!iso) return <span className={styles.none}>Never</span>;
  const local = fmtLocalTime(iso, compact);
  if (!local) return <span className={styles.mono}>{iso}</span>;
  return <time className={styles.time} dateTime={iso} title={fmtUtc(iso) ?? iso}>{local}</time>;
}

/** Bordered JSON block with a wrap toggle and copy. Strings are shown verbatim. */
export function JsonViewer({ data, label, maxHeight = 360 }: { data: unknown; label: string; maxHeight?: number }) {
  const [wrap, setWrap] = useState(true);
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2) ?? "undefined";
  return (
    <div className={styles.json}>
      <div className={styles.jsonHead}>
        <span className={styles.engraved}>{label}</span>
        <span className={styles.jsonActions}>
          <button type="button" className={styles.toggle} aria-pressed={wrap} onClick={() => setWrap(!wrap)}>Wrap</button>
          <CopyButton value={text} label={label} />
        </span>
      </div>
      <pre tabIndex={0} aria-label={label} className={cx(styles.jsonBody, wrap ? styles.wrap : styles.noWrap)} style={{ maxHeight }}>
        {text}
      </pre>
    </div>
  );
}

export type Column<Row> = {
  key: string;
  header: ReactNode;
  render: (row: Row) => ReactNode;
  align?: "start" | "end";
};

/**
 * Data table: a caption (visible or screen-reader only), header cells with scope, an
 * optional sticky identifying column, and a focusable horizontal scroll region.
 */
export function Table<Row>({ caption, captionHidden = false, columns, rows, rowKey, stickyFirstColumn = false, empty }: {
  caption: string;
  captionHidden?: boolean;
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  stickyFirstColumn?: boolean;
  empty?: ReactNode;
}) {
  const captionId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const element=scrollRef.current;
    if(!element)return;
    const measure=()=>setOverflow(element.scrollWidth>element.clientWidth+1);
    measure();
    if(typeof ResizeObserver==='undefined')return;
    const observer=new ResizeObserver(measure);
    observer.observe(element);
    const table=element.querySelector('table');if(table)observer.observe(table);
    return ()=>observer.disconnect();
  },[columns,rows]);
  return (
    <div ref={scrollRef} className={styles.tableScroll} role="region" aria-labelledby={captionId} aria-describedby={overflow?`${captionId}-scroll`:undefined} tabIndex={0}>
      {overflow ? <p id={`${captionId}-scroll`} className={styles.scrollHint}>Scroll table horizontally to see all columns.</p> : null}
      <table className={cx(styles.table, stickyFirstColumn && styles.sticky)}>
        <caption id={captionId} className={captionHidden ? "sr-only" : styles.caption}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={column.align === "end" ? styles.end : undefined}>{column.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={columns.length} className={styles.emptyCell}>{empty ?? "No rows"}</td></tr>
          ) : rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column, index) => {
                const content = column.render(row);
                const className = column.align === "end" ? styles.end : undefined;
                return index === 0
                  ? <th key={column.key} scope="row" className={cx(styles.rowHeader, className)}>{content}</th>
                  : <td key={column.key} className={className}>{content}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
