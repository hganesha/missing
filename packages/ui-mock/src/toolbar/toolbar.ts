import { PERSONAS, ROLE_ACTIONS, SCENARIOS, type ScenarioName } from "../fixtures.js";
import { advanceClock, loadScenario, notify, resetState, type MockState } from "../state.js";

/**
 * Mock toolbar (BUILD-SPEC v2 §6.7): persona, scenario, clock, faults, reset and the
 * contract-violation counter. Framework-free DOM so it never touches app code. Every change
 * dispatches `ehf-mock:change` on window ({detail: {kind}}) so the app can refetch.
 */
const SCENARIO_LABELS: Record<ScenarioName, string> = {
  ownership_review: "S1 · Ownership review",
  screening_review: "S2 · Screening review",
  decision_pending: "S3 · Decision pending",
  second_approval: "S4 · Second approval",
  decided: "S5 · Decided",
};
const SERVICES = ["control-api", "case-api", "capability-gateway"] as const;
const ONE_SHOT = ["offline", "staleBasisNext", "expireSessionNext", "csrfRejectNext"] as const;

let counter = 0;
function id(name: string): string {
  counter += 1;
  return `ehf-mock-${name}-${counter}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, children: Array<Node | string> = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { style, ...rest } = props as { style?: string };
  Object.assign(node, rest);
  if (style) node.setAttribute("style", style);
  for (const child of children) node.append(child);
  return node;
}

function labelled(text: string, control: HTMLElement): HTMLElement {
  control.id ||= id("control");
  return el("div", { style: "display:flex;flex-direction:column;gap:2px" }, [el("label", { htmlFor: control.id, textContent: text }), control]);
}

function section(title: string, children: HTMLElement[]): HTMLElement {
  const fieldset = el("fieldset", { style: "border:1px solid GrayText;border-radius:6px;padding:6px;margin:0;display:flex;flex-direction:column;gap:6px" });
  fieldset.append(el("legend", { textContent: title }), ...children);
  return fieldset;
}

export function mountToolbar(state: MockState): HTMLElement {
  const changed = (kind: string) => {
    notify(state, kind);
    render();
  };
  state.listeners.add((kind) => window.dispatchEvent(new CustomEvent("ehf-mock:change", { detail: { kind } })));

  const root = el("aside", {
    style: "position:fixed;left:12px;bottom:12px;z-index:2147483000;font:12px/1.4 system-ui,sans-serif;color:CanvasText;background:Canvas;border:1px solid GrayText;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.2);max-width:320px",
  });
  root.setAttribute("aria-label", "Mock toolbar");
  const toggle = el("button", { type: "button", textContent: "Mock", style: "padding:6px 10px;width:100%;text-align:left;cursor:pointer" });
  toggle.setAttribute("aria-expanded", "false");
  // Collapsed by default. An inline display would override the hidden attribute, so the
  // panel's display is set explicitly on every toggle.
  const panel = el("div", { hidden: true, style: "padding:8px;display:none;flex-direction:column;gap:8px;max-height:70vh;overflow:auto" });
  toggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    panel.style.display = panel.hidden ? "none" : "flex";
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
  });

  // Persona
  const personaSelect = el("select");
  for (const entry of PERSONAS) personaSelect.append(el("option", { value: entry.persona.personaId, textContent: `${entry.persona.displayName} · ${entry.persona.roleLabel.replace(/\bHarness\b/g, "Process flow")}` }));
  personaSelect.addEventListener("change", () => {
    state.personaId = personaSelect.value;
    state.sessionExpired = false;
    state.revokedRoles.clear();
    changed("session");
  });

  // Scenario
  const scenarioSelect = el("select");
  for (const name of SCENARIOS) scenarioSelect.append(el("option", { value: name, textContent: SCENARIO_LABELS[name] }));
  scenarioSelect.addEventListener("change", () => {
    loadScenario(state, scenarioSelect.value as ScenarioName);
    changed("scenario");
  });

  // Clock
  const clockText = el("output", { style: "font-family:ui-monospace,monospace" });
  const plusHour = el("button", { type: "button", textContent: "+1 h" });
  plusHour.addEventListener("click", () => {
    advanceClock(state, 3600);
    changed("clock");
  });
  const plusDay = el("button", { type: "button", textContent: "+1 d" });
  plusDay.addEventListener("click", () => {
    advanceClock(state, 86_400);
    changed("clock");
  });
  const setInput = el("input", { type: "datetime-local" });
  const setButton = el("button", { type: "button", textContent: "Set" });
  setButton.addEventListener("click", () => {
    if (!setInput.value) return;
    state.clock = new Date(`${setInput.value}Z`).toISOString().replace(/\.000Z$/, "Z");
    changed("clock");
  });

  // Faults
  const latency = el("input", { type: "number", min: "0", step: "50", placeholder: "default" });
  latency.addEventListener("change", () => {
    state.faults.latencyMs = latency.value === "" ? null : Number(latency.value);
    changed("faults");
  });
  const sticky = el("input", { type: "checkbox" });
  const oneShots = ONE_SHOT.map((name) => {
    const box = el("input", { type: "checkbox" });
    box.addEventListener("change", () => {
      (state.faults as unknown as Record<string, boolean>)[name] = box.checked;
      state.faults.sticky = box.checked && sticky.checked ? [...new Set([...state.faults.sticky, name])] : state.faults.sticky.filter((entry) => entry !== name);
      changed("faults");
    });
    return { name, box };
  });
  const failStatus = el("input", { type: "number", value: "500", min: "400", max: "599" });
  const failCode = el("input", { type: "text", value: "bff.upstream_failed" });
  const failArm = el("button", { type: "button", textContent: "Fail next request" });
  failArm.addEventListener("click", () => {
    state.faults.failNext = { status: Number(failStatus.value), error: failCode.value };
    changed("faults");
  });
  const revokeSelect = el("select");
  revokeSelect.append(el("option", { value: "", textContent: "—" }));
  for (const role of Object.keys(ROLE_ACTIONS)) revokeSelect.append(el("option", { value: role, textContent: role }));
  revokeSelect.addEventListener("change", () => {
    state.faults.revokeRoleNext = revokeSelect.value || null;
    changed("faults");
  });
  const downBoxes = SERVICES.map((service) => {
    const box = el("input", { type: "checkbox" });
    box.addEventListener("change", () => {
      state.faults.upstreamDown = SERVICES.filter((_name, index) => downBoxes[index]!.checked);
      changed("faults");
    });
    return box;
  });

  // Reset and violations
  const reset = el("button", { type: "button", textContent: "Reset store" });
  reset.addEventListener("click", () => {
    resetState(state, state.scenario);
    changed("reset");
  });
  const violations = el("output", { style: "font-weight:600" });
  violations.setAttribute("aria-live", "polite");

  const checkbox = (label: string, box: HTMLInputElement) => {
    box.id ||= id("box");
    return el("div", {}, [box, el("label", { htmlFor: box.id, textContent: ` ${label}` })]);
  };

  panel.append(
    labelled("Persona", personaSelect),
    labelled("Scenario", scenarioSelect),
    section("Clock", [el("div", {}, [clockText]), el("div", { style: "display:flex;gap:4px" }, [plusHour, plusDay]), labelled("Set (UTC)", setInput), setButton]),
    section("Faults", [
      labelled("Latency ms", latency),
      checkbox("Keep faults armed (sticky)", sticky),
      ...oneShots.map(({ name, box }) => checkbox(name, box)),
      labelled("Fail next: status", failStatus),
      labelled("Fail next: reason code", failCode),
      failArm,
      labelled("Revoke role at next mutation", revokeSelect),
      ...downBoxes.map((box, index) => checkbox(`${SERVICES[index]} down`, box)),
    ]),
    reset,
    violations,
  );
  root.append(toggle, panel);
  document.body.append(root);

  function render() {
    personaSelect.value = state.personaId;
    scenarioSelect.value = state.scenario;
    clockText.value = state.clock;
    for (const { name, box } of oneShots) box.checked = Boolean((state.faults as unknown as Record<string, boolean>)[name]);
    revokeSelect.value = state.faults.revokeRoleNext ?? "";
    downBoxes.forEach((box, index) => { box.checked = state.faults.upstreamDown.includes(SERVICES[index]!); });
    const count = state.violations.length;
    violations.value = `Contract violations: ${count}`;
    toggle.textContent = count ? `Mock · ${count} violation${count === 1 ? "" : "s"}` : `Mock · ${SCENARIO_LABELS[state.scenario].split(" · ")[0]}`;
  }
  render();
  // Requests mutate state outside the toolbar (one-shot faults, transitions, violations).
  window.setInterval(render, 1000);
  return root;
}
