import styles from "./icon.module.css";
import { ICON_PATHS, type IconName } from "./sprite";

export type { IconName };

export type IconProps = {
  name: IconName;
  size?: "sm" | "md" | "lg" | "xl";
  /** Icons label things; they never carry state alone. Decorative by default. */
  title?: string;
  className?: string;
};

/** Outline icon from the product sprite (STYLE-GUIDE §7). No third-party icon set. */
export function Icon({ name, size = "md", title, className }: IconProps) {
  const path = ICON_PATHS[name];
  return (
    <svg
      className={[styles.icon, styles[size], className].filter(Boolean).join(" ")}
      viewBox="0 0 24 24"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
      // Static, product-owned path data from the sprite; never user content.
      dangerouslySetInnerHTML={{ __html: path }}
    />
  );
}

export function isIconName(name: string): name is IconName {
  return name in ICON_PATHS;
}
