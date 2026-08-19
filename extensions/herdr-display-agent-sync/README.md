# herdr-display-agent-sync

Syncs the pi session's display name into herdr's sidebar so the agent panel
shows a meaningful label (the session name, or a cwd-basename fallback) instead
of just the agent type ("pi").

## What it does

- Reads `ctx.sessionManager.getSessionName()` on `session_start`,
  `agent_start`, `agent_settled`, and `session_info_changed`.
- Falls back to a slugified cwd basename when no session name is set
  (e.g. `/…/herdr` → `herdr`, `/…/herdr-flash` → `herdr-flash`).
- Reports it to herdr via `pane.report_metadata` (`display_agent`) with the
  max TTL (24h). Re-reports on every agent event, so the label refreshes
  naturally and the 24h TTL never visibly expires.
- No-op outside herdr (gates on `HERDR_ENV` / `HERDR_PANE_ID` /
  `HERDR_SOCKET_PATH`).

## Why a separate extension

`~/.pi/agent/extensions/herdr-agent-state.ts` is managed by herdr and
overwritten on `herdr integration install pi`. This extension lives in the
codingfragments repo and is loaded alongside the managed one, so it survives
herdr integration updates.

## Usage

Set a name in pi with `/name <name>`; clear with `/name` (empty). The sidebar
updates on the next agent event (agent_start/settled). When no name is set,
the cwd basename slug is used.

## Security

Only talks to the local herdr unix socket; no network, no file writes, no
secrets. Reads the session name (user-defined) and cwd (already known to
herdr). No exfiltration.
