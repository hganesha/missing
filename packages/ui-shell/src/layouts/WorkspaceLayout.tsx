import {useEffect,useState,type ReactNode} from "react";
import {Button,Sheet} from '@ehf/ui-kit';
import styles from "./WorkspaceLayout.module.css";

/**
 * Domain studio frame: orientation (left), main work surface, inspector (right) and the
 * activity rail (bottom). Regions keep their positions; content never reflows them
 * (STYLE-GUIDE §1, stable geography).
 */
export function WorkspaceLayout({ orient, main, inspector, rail, labels, focusMain = false }: {
  orient?: ReactNode;
  main: ReactNode;
  inspector?: ReactNode;
  rail?: ReactNode;
  /** Give a detailed review surface the full width; retain context in explicit drawers. */
  focusMain?: boolean;
  labels?: { orient?: string; inspector?: string; rail?: string };
}) {
  const [desktop,setDesktop]=useState(()=>typeof window==='undefined'||window.innerWidth>=1080);
  const [drawer,setDrawer]=useState<'orient'|'inspector'|null>(null);
  useEffect(()=>{const resize=()=>setDesktop(window.innerWidth>=1080);window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
  if(!desktop || focusMain)return <div className={styles.narrow}>
    <div className={styles.mobileTools}>{orient?<Button size="sm" icon="panell" onClick={()=>setDrawer('orient')}>Navigation</Button>:null}{inspector?<Button size="sm" icon="panelr" onClick={()=>setDrawer('inspector')}>Inspector</Button>:null}</div>
    <div className={styles.main}>{main}</div>
    {rail && !focusMain?<section className={styles.rail} aria-label={labels?.rail??'Activity'}>{rail}</section>:null}
    <Sheet open={drawer==='orient'} title={labels?.orient??'Navigation'} onClose={()=>setDrawer(null)}>{orient}</Sheet>
    <Sheet open={drawer==='inspector'} title={labels?.inspector??'Inspector'} onClose={()=>setDrawer(null)}>{inspector}</Sheet>
  </div>;
  return (
    <div className={styles.layout} data-orient={orient ? "true" : "false"} data-inspector={inspector ? "true" : "false"}>
      {orient ? <aside className={styles.orient} aria-label={labels?.orient ?? "Orientation"}>{orient}</aside> : null}
      <div className={styles.main}>{main}</div>
      {inspector ? <aside className={styles.inspector} aria-label={labels?.inspector ?? "Inspector"}>{inspector}</aside> : null}
      {rail ? <section className={styles.rail} aria-label={labels?.rail ?? "Activity"}>{rail}</section> : null}
    </div>
  );
}
