// The control room's shell: which screen the address names, the frame around it (header, next-action band,
// Activity strip and drawer), the project map overlay and the "new" badges. The screens themselves are in their
// own modules; app.js only starts it.
import { html, useEffect, useMemo, useRef, useState } from "/vendor/preact-htm.module.js";
import { Annotations } from "./annotations.js";
import { DirectorAsks } from "./asks.js";
import { Config } from "./config.js";
import { useApi, useBus, useHashRoute } from "./core.js";
import { setModels } from "./cost.js";
import { toast } from "./dialog.js";
import { newsTab, nextBand, stepStates, stripState } from "./frame-state.js";
import { ActivityDrawer, ActivityStrip, Header } from "./frame.js";
import { installKeys } from "./keys.js";
import { activityRows } from "./live.js";
import { ProjectMap } from "./map.js";
import { Project } from "./project.js";
import { Recording } from "./recording.js";
import { Render } from "./render.js";
import { readLastPlace, writeLastPlace } from "./route.js";
import { useStages } from "./stages.js";
import { stepOf } from "./steps.js";
import { Review } from "./storyboard.js";
import { Voice } from "./voice.js";

const SCREEN_BODY = {
  project: (p) => html`<${Project} events=${p.events} />`,
  storyboard: (p) => html`<${Review} events=${p.events} stages=${p.stages} />`,
  recording: (p) => html`<${Recording} events=${p.events} stages=${p.stages} />`,
  voice: (p) => html`<${Voice} events=${p.events} stages=${p.stages} />`,
  annotations: (p) => html`<${Annotations} events=${p.events} stages=${p.stages} />`,
  render: (p) => html`<${Render} events=${p.events} stages=${p.stages} />`,
  config: (p) => html`<${Config} events=${p.events} />`,
};

export function App() {
  useEffect(installKeys, []);
  const [route, go] = useHashRoute();
  const { events, status } = useBus();
  const { data: state, error: stateError } = useApi("/api/state", events, /^(?!draft\.)/);
  setModels(state?.models);
  const { data: stages } = useStages(events);
  const { data: jobData } = useApi(
    "/api/jobs",
    events,
    /^(take|tts|edit|render|design|discovery)\./,
  );
  const jobs = jobData?.jobs ?? [];
  const slug = state?.project?.slug ?? null;
  const [notice, setNotice] = useState(null);
  const [drawer, setDrawer] = useState(false);
  const [dismissed, setDismissed] = useState(() => new Set());
  const [news, setNews] = useState(() => new Set());
  const stripButton = useRef(null);

  // Where we are comes from the URL. An empty hash restores the last place in this project (or starts
  // at Project); an unknown route says so and falls back, it never silently shows something else.
  useEffect(() => {
    if (!state) return;
    if (route === null) go(readLastPlace(slug) ?? { screen: "project" }, { replace: true });
    else if (!route.valid) {
      setNotice(`${route.reason}. Showing Project.`);
      go({ screen: "project" }, { replace: true });
    }
  }, [state, route]);
  // The map is an overlay: the screen under it stays the current screen (and the one remembered).
  const mapOpen = route?.valid && route.screen === "map";
  const under = useRef(null);
  const cameFrom = useRef(false); // the entry before the map is one of ours: closing can go Back
  if (route?.valid && route.screen !== "map") under.current = route;
  const tab = mapOpen
    ? (under.current?.screen ?? "project")
    : route?.valid
      ? route.screen
      : "project";
  useEffect(() => {
    if (slug && route?.valid && route.screen !== "map") writeLastPlace(slug, route);
  }, [slug, route?.raw]);
  const wasMap = useRef(false);
  useEffect(() => {
    // the first map route of a visit: was there a screen before it in this tab's history?
    if (mapOpen && !wasMap.current) cameFrom.current = !!under.current;
    wasMap.current = !!mapOpen;
  }, [mapOpen]);
  const closeMap = () => {
    if (cameFrom.current && history.length > 1) history.back();
    else go(under.current ?? readLastPlace(slug) ?? { screen: "project" }, { replace: true });
  };
  useEffect(() => setNotice(null), [tab]);

  // A result that arrives for another screen puts a badge on its step. It never moves you.
  // History is whatever the engine had published when this page first asked for the state.
  const historyUntil = useRef(null);
  if (state && historyUntil.current === null) historyUntil.current = state.busSeq ?? 0;
  const seen = useRef(0);
  const here = useRef(tab);
  here.current = tab;
  useEffect(() => {
    if (historyUntil.current === null) return; // not known yet: nothing is judged
    const fresh = events.filter((e) => e.seq > seen.current);
    if (!fresh.length) return;
    seen.current = fresh.at(-1).seq;
    const live = fresh.filter((e) => e.seq > historyUntil.current);
    // run-and-tell (steps.js): a result that arrived by itself is a badge on its screen, and a toast when you are
    // looking at that screen; an alert is never silent
    for (const e of live) {
      const step = stepOf(e);
      const said = typeof e.data?.message === "string" ? e.data.message : "";
      if (step?.class === "alert" && said) toast(said, { kind: "error" });
      else if (step?.class === "run-and-tell" && step.tab === here.current && said)
        toast(said, { kind: "info" });
    }
    const add = live.map(newsTab).filter((t) => t && t !== here.current);
    if (add.length) setNews((n) => new Set([...n, ...add]));
  }, [events, state]);
  useEffect(
    () =>
      setNews((n) => {
        if (!n.has(tab)) return n;
        const m = new Set(n);
        m.delete(tab);
        return m;
      }),
    [tab],
  );

  const rows = useMemo(() => activityRows(events), [events]);
  const discovery = rows.some((r) => r.key === "discovery" && r.state === "running");
  const states = useMemo(() => stepStates({ stages, jobs, discovery }), [stages, jobs, discovery]);
  const band = useMemo(() => nextBand({ stages, states, jobs }), [stages, states, jobs]);
  const strip = useMemo(
    () => stripState({ jobs, rows, status, dismissed }),
    [jobs, rows, status, dismissed],
  );
  const body = (SCREEN_BODY[tab] ?? SCREEN_BODY.project)({ events, stages });
  return html`
    <${Header} slug=${slug} tab=${tab} states=${states} news=${news} band=${band} />
    <main class=${tab}>
      ${notice ? html`<div class="ds-root ds-notice route-notice" role="note" data-tone="warn"><span class="ds-status" data-tone="warn" aria-hidden="true">!</span><div class="ds-grow">${notice}</div><button class="ds-btn ds-btn--sm" type="button" onClick=${() => setNotice(null)}>Dismiss</button></div>` : null}
      <${DirectorAsks} events=${events} />
      ${stateError ? html`<section class="card error">${stateError}</section>` : null}
      ${body}
    </main>
    ${mapOpen ? html`<${ProjectMap} route=${route} go=${go} slug=${slug} events=${events} onClose=${closeMap} />` : null}
    <${ActivityStrip} strip=${strip} status=${status} open=${drawer} buttonRef=${stripButton}
      onToggle=${(forceOpen) => setDrawer((o) => (forceOpen === true ? true : !o))} />
    <${ActivityDrawer} open=${drawer} onClose=${() => setDrawer(false)} events=${events} rows=${rows} jobs=${jobs}
      dismissed=${dismissed} onDismiss=${(id) => setDismissed((d) => new Set([...d, id]))} buttonRef=${stripButton} />`;
}
