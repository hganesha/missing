import { cloneElement, isValidElement, useId, type InputHTMLAttributes, type ReactElement, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import styles from "./form.module.css";

type ControlA11y = { id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean };

/**
 * Label, hint and error around one control. Wires `id`, `aria-describedby` and
 * `aria-invalid` so the control is announced with its hint and error.
 */
export function Field({ label, hint, error, children }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactElement<ControlA11y> }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const control = isValidElement(children)
    ? cloneElement(children, { id, "aria-describedby": describedBy, ...(error ? { "aria-invalid": true } : {}) })
    : children;
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>{label}</label>
      {control}
      {hint ? <span id={hintId} className={styles.hint}>{hint}</span> : null}
      {error ? <span id={errorId} className={styles.error} role="alert">{error}</span> : null}
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  const { mono, className, ...rest } = props;
  return <input {...rest} className={[styles.input, mono && styles.mono, className].filter(Boolean).join(" ")} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  const { mono, className, ...rest } = props;
  return <textarea {...rest} className={[styles.input, styles.textarea, mono && styles.mono, className].filter(Boolean).join(" ")} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className, ...rest } = props;
  return <select {...rest} className={[styles.input, styles.select, className].filter(Boolean).join(" ")} />;
}
