# Spike S7: reusing a manual login (D5), and telling when it is gone

**Question.** You log in by hand (a password, OAuth, an e-mail link, a one-time code) and the Director and the recorder reuse that session. What does a saved
Playwright `storageState` really keep, how does a session that has expired look to a headless browser, and can the engine tell without knowing the app?

**Answer: a saved state keeps cookies, localStorage and IndexedDB, and does not keep sessionStorage. An expired session is recognisable without knowing the app (a
redirect to a login-looking address and a password field), so one rule can serve discovery, recording and the check after the save.**

Observed in real Chromium against a small fixture app (`test/s7-spike-auth.test.ts`, no network; Playwright 1.64). Headed login (a window on your screen) was not run in the test.

## What was observed

| # | Observation | Consequence |
|---|---|---|
| A1 | Login by a **cookie** (also one with no expiry, a "browser-session" cookie) is saved and reused by a later headless context. | The usual case works. |
| A2 | A token in **localStorage** is saved and reused. | Token-in-the-page SPAs work. |
| A3 | A token in **IndexedDB** is saved **only with `storageState({ indexedDB: true })`** (Playwright 1.51 and later) and reused. | Always save with `indexedDB: true` (Firebase and some auth libraries keep the login there). |
| A4 | A token in **sessionStorage** is **not** in the saved state: the later context is logged out. | Some apps cannot be reused by a saved state. The engine must **check after saving** (a fresh headless context opens the app and must be logged in) and say so when it is not. |
| A5 | When the server forgets the session, the same saved state lands on `/login` (a redirect, HTTP 200 on the final page) and the page has a password field. | **The engine can tell**: the final URL looks like a login (`login`, `sign-in`, `sso`, `auth`) or the page has a visible password field. No per-app rule is needed for the common case. |
| A6 | The state file holds live credentials (cookies, tokens). The project's zip must not carry it (done in E: `auth/` is left out) and the file is owner-only. | `auth/` stays `0700`, the file `0600`; the Director and the panel never read its content, only its age and the probe's result. |

## What S7 needs, from this

- **Login:** a headed browser opened on the app, you log in by hand, press "I'm logged in", the state is saved (`indexedDB: true`, `0600`), and a fresh headless
  context **verifies** it before the engine says "saved".
- **Probe:** open the app's start page headless with the saved state; logged out when it lands on a login-looking address or shows a password field (A5); an optional
  rule per app (a URL to open, a text or selector that proves you are in) for apps where the heuristic is wrong.
- **Checks:** before discovery and before recording (cheap, headless), and **after every navigation inside a take**.
- **Expiry in a take:** the take stops at that scene (not "failed"), you are asked to log in again, and the recording goes on from that scene (the recorder already resumes
  from a scene).
- **Not kept (A4):** sessionStorage-only logins. Said, not hidden.

## Not run

- A headed window (it needs your screen); the engine takes a headed/headless switch so tests use a headless one, and the real window is the first thing to try on your app.
- A real OAuth, e-mail-link or one-time-code login (they all end as cookies or storage; the manual step is the same).
