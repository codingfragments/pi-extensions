// What a running Activity row's Stop / Cancel does (item 24). Pure, so it is tested on its own.

/**
 * What a running row's Stop does (item 24, R3-15): the route, its label, and whether it asks first. A take, the voice and discovery ask (they spend, or they
 * cannot be resumed); the others stop at once. The Director's stop is pi's Esc for its turn.
 */
export const STOPPABLE = {
  take: {
    route: "/api/job-cancel",
    body: { kind: "take" },
    label: "Cancel",
    ask: "Cancel the recording? The take is marked cancelled; what it recorded so far stays on disk.",
  },
  tts: {
    route: "/api/job-cancel",
    body: { kind: "tts" },
    label: "Cancel",
    ask: "Cancel the voice synthesis? Sections already made are billed and cached: starting it again reuses them.",
  },
  edit: { route: "/api/job-cancel", body: { kind: "edit" }, label: "Cancel" },
  render: { route: "/api/job-cancel", body: { kind: "render" }, label: "Cancel" },
  design: { route: "/api/job-cancel", body: { kind: "design" }, label: "Cancel" },
  discovery: {
    route: "/api/discovery-stop",
    body: {},
    label: "Stop",
    ask: "Stop the discovery session? What it saw is kept; the Director works from that.",
  },
  director: { route: "/api/director-stop", body: {}, label: "Stop" },
};
