import { Button, Icon, type IconName } from "@ehf/ui-kit";
import { useEffect, useState, type ReactNode } from "react";
import styles from "./ConsoleLayout.module.css";

export type ConsoleNavItem = { id: string; label: string; icon: IconName; href: string; active: boolean };

/**
 * Platform console frame (ui-specs §2.1): section nav (248 px, 72 px icon rail, drawer) and
 * the content column. Each surface renders its own ConsoleHeader so titles, freshness and
 * actions can follow its data. The app supplies `renderLink`, so this package never depends
 * on the router.
 */
export function ConsoleLayout({ navTitle, nav, renderLink, children, pathKey }: {
  navTitle: string;
  nav: readonly ConsoleNavItem[];
  renderLink: (item: ConsoleNavItem, props: { className: string; children: ReactNode; "aria-current"?: "page" }) => ReactNode;
  children: ReactNode;
  /** Changes on navigation; closes the narrow-screen drawer. */
  pathKey?: string;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- close the drawer after navigation
  useEffect(() => setDrawerOpen(false), [pathKey]);
  return (
    <div className={styles.layout}>
      <nav aria-label={navTitle} className={styles.nav} data-open={drawerOpen}>
        <div className={`${styles.navTitle} t-engraved`}>{navTitle}</div>
        <ul className={styles.navList}>
          {nav.map((item) => (
            <li key={item.id}>
              {renderLink(item, {
                className: styles.navLink!,
                ...(item.active ? { "aria-current": "page" as const } : {}),
                children: (<><Icon name={item.icon} /><span className={styles.navLabel}>{item.label}</span></>),
              })}
            </li>
          ))}
        </ul>
      </nav>
      <div className={styles.main}>
        <Button className={styles.drawerButton} size="sm" icon="panell" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(!drawerOpen)}>
          {drawerOpen ? "Hide sections" : "Sections"}
        </Button>
        {children}
      </div>
    </div>
  );
}

/** Page header for a console surface: breadcrumb, title, meta line, freshness and actions. */
export function ConsoleHeader({ breadcrumb = [], title, titleLabel, meta, actions }: {
  breadcrumb?: ReadonlyArray<{ label: string; href?: string }>;
  title: ReactNode;
  /** Keeps the heading's name stable when its title includes editing controls. */
  titleLabel?: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className={styles.topbar}>
      <div>
        {breadcrumb.length ? (
          <nav aria-label="Breadcrumb">
            <ol className={`${styles.crumbs} t-engraved`}>
              {breadcrumb.map((crumb, index) => (
                <li key={`${crumb.label}-${index}`}>{crumb.href ? <a href={crumb.href}>{crumb.label}</a> : <span aria-current="page">{crumb.label}</span>}</li>
              ))}
            </ol>
          </nav>
        ) : null}
        <h1 className={styles.title} aria-label={titleLabel}>{title}</h1>
        {meta ? <div className={styles.meta}>{meta}</div> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  );
}
