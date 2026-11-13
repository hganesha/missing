import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import styles from "./tabs.module.css";

export type TabItem<V extends string> = { value: V; label: ReactNode; count?: number };

/**
 * WAI-ARIA tabs with automatic activation and roving tabindex: ←/→ move, Home/End jump.
 * The selected value usually lives in the URL (`?tab=`), so the parent owns it.
 */
export function Tabs<V extends string>({ label, items, value, onChange, renderPanel }: {
  label: string;
  items: readonly TabItem<V>[];
  value: V;
  onChange: (value: V) => void;
  /** Renders the selected panel. Only the selected panel is mounted. */
  renderPanel?: (value: V) => ReactNode;
}) {
  const base = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(0, items.findIndex((item) => item.value === value));
  const tabId = (index: number) => `${base}-tab-${index}`;
  const panelId = `${base}-panel`;

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    let next: number | undefined;
    if (event.key === "ArrowRight") next = (index + 1) % items.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    onChange(items[next]!.value);
    refs.current[next]?.focus();
  };

  return (
    <div>
      <div role="tablist" aria-label={label} className={styles.tablist}>
        {items.map((item, index) => {
          const selected = index === selectedIndex;
          return (
            <button
              key={item.value}
              ref={(element) => { refs.current[index] = element; }}
              id={tabId(index)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={renderPanel ? panelId : undefined}
              tabIndex={selected ? 0 : -1}
              className={styles.tab}
              onClick={() => onChange(item.value)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {item.label}
              {item.count !== undefined ? <span className={styles.count}>{item.count}</span> : null}
            </button>
          );
        })}
      </div>
      {renderPanel ? (
        <div role="tabpanel" id={panelId} aria-labelledby={tabId(selectedIndex)} tabIndex={0} className={styles.panel}>
          {renderPanel(items[selectedIndex]!.value)}
        </div>
      ) : null}
    </div>
  );
}
