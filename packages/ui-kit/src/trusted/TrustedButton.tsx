import type { ButtonHTMLAttributes } from "react";
import { Icon } from "../icon/Icon";
import styles from "./trusted.module.css";

/**
 * The P3 commit control. It exists only for TrustedDecisionSheet and is exported from
 * `@ehf/ui-kit/trusted`, never from the main entry (BUILD-SPEC v2 N7, §13.3). Agent-composed
 * content must never render it.
 */
export function TrustedButton({ children, busy = false, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & { busy?: boolean }) {
  return (
    <button {...rest} type="button" aria-busy={busy || undefined} className={styles.trusted}>
      <Icon name="lock" size="sm" />
      {children}
    </button>
  );
}
