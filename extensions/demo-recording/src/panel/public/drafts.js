// Working drafts in the panel (UX5b, D115, D121): the unsaved edits of an artifact, autosaved to the project
// and kept apart from versions. The engine contract is in src/drafts/store.ts and docs/ux/UX5a.md; this hook
// is the client's half of it:
//
//  - your text stays in the page until the server confirms it, so a failed or rejected save never loses it
//    (it is NOT kept across a reload: the page warns before it is closed with unsaved text);
//  - every write carries the revision you last saw; a rejected one becomes a visible conflict with a choice,
//    never a silent overwrite;
//  - Save new version first flushes what is pending, then asks for exactly one version;
//  - nothing here approves, switches the production line, or starts a job.
import { html, useCallback, useEffect, useRef, useState } from "/vendor/preact-htm.module.js";
import { api, post } from "./core.js";
import { confirmAsk, errorToast } from "./dialog.js";

/** This tab, so the page can tell its own saves from another tab's. */
export const TAB = (globalThis.crypto?.randomUUID?.() ?? String(Math.random())).slice(0, 12);
export const AUTOSAVE_MS = 800;

const norm = (s) =>
  String(s ?? "")
    .trim()
    .replace(/\r\n/g, "\n");

/** The statuses the UI words: clean · dirty · saving · saved · failed · conflict. */
export function saveStateText(state, changes) {
  switch (state.status) {
    case "dirty":
      return "Unsaved changes…";
    case "saving":
      return "Saving…";
    case "saved":
      return `Draft saved ${state.at ?? ""} · not a new version yet`.replace("  ", " ");
    case "failed":
      return `Save failed: ${state.error ?? "no answer"}. Your text is kept here.`;
    case "conflict":
      return "This draft was changed elsewhere. Choose what to keep.";
    default:
      return changes
        ? `Working draft: ${changes} section${changes === 1 ? "" : "s"} changed · not a new version yet`
        : "No edits yet. Editing keeps a working draft; it is not a new version.";
  }
}

const clock = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * `base` is the version being edited, `bodies` its sections' texts by key (an edit equal to its body is no
 * change). Returns the edited texts, the save state, the conflict if any, and the actions.
 */
export function useDraft({ base, bodies, events, onSaved }) {
  const [texts, setTexts] = useState({});
  const [state, setState] = useState({ status: "clean" });
  const [server, setServer] = useState(null);
  const [conflict, setConflict] = useState(null);
  const rev = useRef(null);
  const pending = useRef(new Set());
  const timer = useRef(null);
  const inflight = useRef(null);
  const textsRef = useRef({});
  const bodiesRef = useRef(bodies);
  const statusRef = useRef("clean");
  const baseRef = useRef(base);
  textsRef.current = texts;
  bodiesRef.current = bodies;
  baseRef.current = base;
  statusRef.current = state.status;

  const changedKeys = (t) =>
    Object.keys(t).filter((k) => norm(t[k]) !== norm(bodiesRef.current?.[k]));
  const changes = changedKeys(texts).length;

  /** What goes to the server for the keys in `keys`: the text, or null where it equals the base. */
  const editsFor = (keys) =>
    Object.fromEntries(
      [...keys].map((k) => {
        const t = textsRef.current[k];
        return [k, t === undefined || norm(t) === norm(bodiesRef.current?.[k]) ? null : t];
      }),
    );

  const adopt = (d, status) => {
    rev.current = d?.draft?.revision ?? d?.revision ?? null;
    setServer(d?.draft ? d : null);
    setTexts(d?.edits ?? {});
    pending.current = new Set();
    setConflict(null);
    setState({ status });
  };

  const load = useCallback(() => {
    if (!base) return Promise.resolve();
    const forBase = base;
    return api(`/api/draft?stage=vo&base=${base}`).then((d) => {
      if (baseRef.current !== forBase) return;
      if (
        pending.current.size ||
        ["saving", "dirty", "failed", "conflict"].includes(statusRef.current)
      )
        return;
      adopt(d, "clean");
    });
  }, [base]);

  // the draft of this version, when it is opened or changes under us
  useEffect(() => {
    rev.current = null;
    pending.current = new Set();
    setTexts({});
    setServer(null);
    setConflict(null);
    setState({ status: "clean" });
    load().catch(() => setState({ status: "failed", error: "the draft could not be read" }));
  }, [base]);

  const send = async (edits, expected) => {
    const r = await post("/api/draft-save", {
      stage: "vo",
      base: baseRef.current,
      revision: expected,
      edits,
      author: TAB,
    });
    return r;
  };

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    if (inflight.current) {
      await inflight.current;
      if (!pending.current.size) return;
    }
    if (!pending.current.size || !baseRef.current) return;
    if (statusRef.current === "conflict") return;
    const keys = [...pending.current];
    const sent = Object.fromEntries(keys.map((k) => [k, textsRef.current[k]]));
    setState({ status: "saving" });
    const run = (async () => {
      try {
        const r = await send(editsFor(keys), rev.current);
        if (r.saved) {
          rev.current = r.draft.revision;
          setServer(r);
          for (const k of keys) if (textsRef.current[k] === sent[k]) pending.current.delete(k);
          if (pending.current.size) {
            setState({ status: "dirty" });
            timer.current = setTimeout(() => flush(), AUTOSAVE_MS);
          } else setState({ status: "saved", at: clock() });
        } else {
          setConflict({ current: r.current, message: r.message });
          setState({ status: "conflict" });
        }
      } catch (e) {
        setState({ status: "failed", error: e.message });
      }
    })();
    inflight.current = run;
    await run;
    inflight.current = null;
  }, []);

  const setText = useCallback((key, text) => {
    setTexts((t) => ({ ...t, [key]: text }));
    textsRef.current = { ...textsRef.current, [key]: text };
    pending.current.add(key);
    if (statusRef.current !== "conflict") setState({ status: "dirty" });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => flush(), AUTOSAVE_MS);
  }, []);

  /** Keep my text: send everything I have, drop what only the other side had. */
  const keepMine = async () => {
    const theirs = conflict?.current;
    const mine = changedKeys(textsRef.current);
    const edits = editsFor(mine);
    for (const k of Object.keys(theirs?.edits ?? {})) if (!(k in edits)) edits[k] = null;
    setState({ status: "saving" });
    try {
      const r = await send(edits, theirs?.draft?.revision ?? null);
      if (r.saved) {
        rev.current = r.draft.revision;
        setServer(r);
        pending.current = new Set();
        setConflict(null);
        setState({ status: "saved", at: clock() });
      } else {
        setConflict({ current: r.current, message: r.message });
        setState({ status: "conflict" });
      }
    } catch (e) {
      setState({ status: "failed", error: e.message });
    }
  };

  /** Take theirs: my unsaved text is replaced by the draft as it is now. */
  const takeTheirs = () => adopt(conflict?.current ? { ...conflict.current } : null, "clean");

  const saveVersion = async () => {
    clearTimeout(timer.current);
    await flush();
    if (["failed", "conflict"].includes(statusRef.current) || pending.current.size) return null;
    try {
      const r = await post("/api/draft-version", {
        stage: "vo",
        base: baseRef.current,
        revision: rev.current,
      });
      if (!r.saved) {
        setConflict({ current: r.current, message: r.message });
        setState({ status: "conflict" });
        return null;
      }
      adopt(null, "clean");
      onSaved?.(r);
      return r;
    } catch (e) {
      errorToast(e, "Save new version");
      return null;
    }
  };

  const discard = async () => {
    const keys = changedKeys(textsRef.current);
    const ok = await confirmAsk({
      title: `Discard the working draft of v${baseRef.current}?`,
      text: `This drops your unsaved edits of ${keys.join(", ") || "this version"}. The saved version is not changed.`,
      danger: true,
      confirmLabel: "Discard draft",
    });
    if (!ok) return false;
    clearTimeout(timer.current);
    try {
      const r = await post("/api/draft-discard", {
        stage: "vo",
        base: baseRef.current,
        revision: rev.current,
      });
      if (r.conflict) {
        setConflict({ current: r.current, message: r.message });
        setState({ status: "conflict" });
        return false;
      }
      adopt(null, "clean");
      return true;
    } catch (e) {
      errorToast(e, "Discard draft");
      return false;
    }
  };

  // another tab (or a save from this one) changed the draft: adopt it when nothing of mine is at stake
  const seen =
    events.filter((e) => e.type === "draft.changed" && e.data?.base === base).at(-1)?.seq ?? 0;
  useEffect(() => {
    const e = events.findLast?.((x) => x.seq === seen);
    if (seen && e?.data?.author !== TAB) load().catch(() => {});
  }, [seen]);

  // unsaved text is not recoverable after the page closes: say so, and save what can be saved on the way out
  useEffect(() => {
    const warn = (e) => {
      if (pending.current.size || ["failed", "conflict"].includes(statusRef.current)) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      if (pending.current.size) flush();
    };
  }, []);

  return {
    texts,
    setText,
    state,
    changes,
    changedKeys: () => changedKeys(texts),
    server,
    flags: server?.flags ?? null,
    conflict,
    retry: flush,
    keepMine,
    takeTheirs,
    saveVersion,
    discard,
    reload: load,
  };
}

/** Mine against theirs (a conflict) or the draft against the newest version, section by section. */
export function CompareTable({ rows, aLabel, bLabel }) {
  if (!rows.length) return html`<p class="ds-small ds-muted">Nothing differs.</p>`;
  return html`<div class="ds-compare" role="table" aria-label=${`${aLabel} compared with ${bLabel}`}>
    <div class="ds-compare-row ds-compare-head" role="row"><span role="columnheader">Section</span><span role="columnheader">${aLabel}</span><span role="columnheader">${bLabel}</span></div>
    ${rows.map(
      (r) => html`<div class="ds-compare-row" role="row" key=${r.key}>
        <strong role="rowheader">${r.key}</strong><span role="cell">${r.a || "(empty)"}</span><span role="cell">${r.b || "(empty)"}</span>
      </div>`,
    )}
  </div>`;
}
