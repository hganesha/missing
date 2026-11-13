import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { Icon, type IconName } from "../icon/Icon";
import styles from "./controls.module.css";

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
  /** There is deliberately no "trusted" variant: that lives only in TrustedDecisionSheet. */
  variant?: "primary" | "secondary" | "quiet";
  size?: "md" | "sm";
  icon?: IconName;
  type?: "button" | "submit" | "reset";
  /** Shows a busy state; the button stays focusable and announces the label. */
  busy?: boolean;
};

export function Button({ variant = "secondary", size = "md", icon, busy = false, type = "button", className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled}
      aria-busy={busy || undefined}
      className={cx(styles.button, styles[variant], size === "sm" && styles.small, !children && styles.iconOnly, className)}
    >
      {icon ? <Icon name={icon} size={size === "sm" ? "sm" : "md"} /> : null}
      {children}
    </button>
  );
}

export type SegmentOption<V extends string> = { value: V; label: ReactNode; disabled?: boolean };

/**
 * Single choice among a few options. A radio group with roving tabindex: arrows move and
 * select, Home/End jump. Selection is shown by surface and weight, not colour.
 */
export function SegmentedControl<V extends string>({ label, options, value, onChange, size = "md" }: {
  label: string;
  options: readonly SegmentOption<V>[];
  value: V;
  onChange: (value: V) => void;
  size?: "md" | "sm";
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = options.map((option, index) => (option.disabled ? -1 : index)).filter((index) => index >= 0);
  const move = (event: KeyboardEvent, index: number) => {
    const position = enabled.indexOf(index);
    let next: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = enabled[(position + 1) % enabled.length];
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = enabled[(position - 1 + enabled.length) % enabled.length];
    else if (event.key === "Home") next = enabled[0];
    else if (event.key === "End") next = enabled[enabled.length - 1];
    if (next === undefined) return;
    event.preventDefault();
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className={cx(styles.segmented, size === "sm" && styles.segmentedSmall)}>
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(element) => { refs.current[index] = element; }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={option.disabled}
            className={styles.segment}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => move(event, index)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A configuration toggle. Never used to show execution success (STYLE-GUIDE §2.3). */
export function Switch({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={styles.switch}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Chip({ children, outline = false, onRemove, removeLabel }: { children: ReactNode; outline?: boolean; onRemove?: () => void; removeLabel?: string }) {
  return (
    <span className={cx(styles.chip, outline && styles.chipOutline)}>
      {children}
      {onRemove ? (
        <button type="button" className={styles.chipRemove} aria-label={removeLabel ?? "Remove"} onClick={onRemove}>
          <Icon name="x" size="sm" />
        </button>
      ) : null}
    </span>
  );
}

/** Copy a value to the clipboard and say so for screen readers. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const statusId = useId();
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <>
      <button
        type="button"
        className={styles.copy}
        aria-label={`Copy ${label}`}
        aria-describedby={statusId}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => setCopied(false));
        }}
      >
        <Icon name={copied ? "check" : "copy"} size="sm" />
      </button>
      <span id={statusId} role="status" className="sr-only">{copied ? `${label} copied` : ""}</span>
    </>
  );
}
