// Acme Pulse — deterministic fixture SPA for demo-recording tests (D20).
// Routes: /  /search?q=  /chat  /item/:id  /settings
// Flags:  ?slow=1  → 4s spinner before search results (dead-time cut test)
//         ?flaky=1 → error toast (role=alert) on the dashboard (QA detector test)
import {
  ACCOUNTS,
  ASSISTANT_ANSWERS,
  ASSISTANT_FALLBACK,
  CHURN_BY_REGION,
  KPIS,
  formatArr,
} from "/data.js";

const view = document.getElementById("view");
const flags = new URLSearchParams(location.search);
const SLOW = flags.get("slow") === "1";
const FLAKY = flags.get("flaky") === "1";
const chatLog = [];
let pendingTimers = [];

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

function later(fn, ms) {
  const id = setTimeout(fn, ms);
  pendingTimers.push(id);
  return id;
}

function toast(text, kind = "info") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  if (kind === "error") el.setAttribute("role", "alert");
  el.textContent = text;
  document.getElementById("toasts").appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

/** Keep debug flags (slow/flaky) across in-app navigation. */
function withFlags(path) {
  const url = new URL(path, location.origin);
  for (const f of ["slow", "flaky"]) if (flags.get(f)) url.searchParams.set(f, flags.get(f));
  return url.pathname + url.search;
}

export function navigate(path) {
  history.pushState(null, "", withFlags(path));
  route();
}

// ---------- views ----------

function dashboard() {
  const max = Math.max(...CHURN_BY_REGION.map((r) => r.churn));
  const risky = ACCOUNTS.filter((a) => a.risk === "High").sort((a, b) => b.arr - a.arr);
  view.innerHTML = `
    <h1>Customer health</h1>
    <p class="sub">Last 90 days · all regions</p>
    <section class="kpis">
      ${KPIS.map(
        (k) => `<article class="kpi" data-kpi="${k.id}">
          <div class="label">${esc(k.label)}</div>
          <div class="value">${esc(k.value)}</div>
          <div class="delta ${k.trend}">${esc(k.delta)}</div>
        </article>`,
      ).join("")}
    </section>
    <section class="grid2">
      <article class="panel">
        <h2>Churn by region</h2>
        <svg class="chart" viewBox="0 0 420 200" role="img" aria-label="Churn by region bar chart">
          ${CHURN_BY_REGION.map((r, i) => {
            const h = Math.round((r.churn / max) * 140);
            const x = 30 + i * 100;
            return `<g data-region="${r.code}">
              <rect x="${x}" y="${170 - h}" width="56" height="${h}" rx="4" class="${r.churn === max ? "hot" : ""}"></rect>
              <text x="${x + 28}" y="${160 - h}" text-anchor="middle" class="val">${r.churn}%</text>
              <text x="${x + 28}" y="190" text-anchor="middle">${r.code}</text>
            </g>`;
          }).join("")}
        </svg>
      </article>
      <article class="panel">
        <h2>Top accounts at risk</h2>
        <table>
          <thead><tr><th>Account</th><th>Region</th><th>ARR</th><th>Health</th></tr></thead>
          <tbody>
            ${risky
              .map(
                (a) => `<tr>
                  <td><a href="/item/${a.id}" data-link>${esc(a.name)}</a></td>
                  <td>${esc(a.region)}</td><td>${formatArr(a.arr)}</td>
                  <td><span class="health bad">${a.health}</span></td></tr>`,
              )
              .join("")}
          </tbody>
        </table>
      </article>
    </section>`;
  if (FLAKY) later(() => toast("Couldn't load segment: Enterprise", "error"), 1500);
}

function searchAccounts(q) {
  const terms = q
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t && !["by", "the", "and", "of", "in"].includes(t));
  if (!terms.length) return [];
  return ACCOUNTS.filter((a) => {
    const hay = `${a.name} ${a.region} ${a.industry} ${a.risk} risk`.toLowerCase();
    return terms.some((t) => hay.includes(t));
  });
}

function search() {
  const q = new URLSearchParams(location.search).get("q") ?? "";
  view.innerHTML = `
    <h1>Search</h1>
    <form class="searchbar" role="search">
      <input type="search" name="q" aria-label="Search" placeholder="Search accounts, regions, industries…" value="${esc(q)}" autocomplete="off" />
      <button type="submit">Search</button>
    </form>
    <div id="results"></div>`;
  const form = view.querySelector("form");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const value = form.q.value.trim();
    history.pushState(
      null,
      "",
      withFlags(`/search${value ? `?q=${encodeURIComponent(value)}` : ""}`),
    );
    showResults(value);
  });
  if (q) showResults(q);
}

function showResults(q) {
  const box = view.querySelector("#results");
  if (!box) return;
  box.innerHTML = `<div class="spinner" aria-busy="true" aria-label="Loading results"></div>`;
  later(() => renderResults(box, q), SLOW ? 4000 : 350);
}

function renderResults(box, q) {
  const wantsRegions = /region/i.test(q) && /churn/i.test(q);
  const hits = searchAccounts(q);
  box.innerHTML = `
    <h2>Results <span class="count">${wantsRegions ? CHURN_BY_REGION.length : hits.length}</span></h2>
    ${
      wantsRegions
        ? `<table class="regions"><thead><tr><th>Region</th><th>Gross churn</th><th>Accounts</th></tr></thead><tbody>
            ${CHURN_BY_REGION.map((r) => `<tr data-region="${r.code}"><td>${esc(r.region)}</td><td>${r.churn}%</td><td>${r.accounts}</td></tr>`).join("")}
          </tbody></table>`
        : hits.length
          ? `<ul class="hits">${hits
              .map(
                (a) => `<li><a href="/item/${a.id}" data-link>${esc(a.name)}</a>
                  <span>${esc(a.region)} · ${esc(a.industry)} · ${formatArr(a.arr)} · risk ${esc(a.risk)}</span></li>`,
              )
              .join("")}</ul>`
          : `<p class="empty">No accounts match “${esc(q)}”.</p>`
    }`;
}

function chat() {
  view.innerHTML = `
    <h1>Assistant</h1>
    <section class="chat">
      <ol class="messages" aria-live="polite"></ol>
      <form class="composer">
        <input type="text" name="msg" aria-label="Ask a question" placeholder="Ask about churn, revenue, accounts…" autocomplete="off" />
        <button type="submit">Send</button>
      </form>
    </section>`;
  const list = view.querySelector(".messages");
  const paint = () => {
    list.innerHTML = chatLog
      .map(
        (m) =>
          `<li class="msg ${m.role}"><div class="bubble"${m.streaming ? ' aria-busy="true"' : ""}>${esc(m.text)}${m.streaming ? '<span class="caret"></span>' : ""}</div></li>`,
      )
      .join("");
    list.scrollTop = list.scrollHeight;
  };
  paint();
  const form = view.querySelector("form");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = form.msg.value.trim();
    if (!text) return;
    form.msg.value = "";
    chatLog.push({ role: "user", text });
    const lower = text.toLowerCase();
    const full =
      ASSISTANT_ANSWERS.find((a) => a.keywords.some((k) => lower.includes(k)))?.answer ??
      ASSISTANT_FALLBACK;
    const reply = { role: "assistant", text: "", streaming: true };
    chatLog.push(reply);
    paint();
    const words = full.split(" ");
    let i = 0;
    const tick = () => {
      if (!view.contains(list)) return;
      reply.text = words.slice(0, ++i).join(" ");
      if (i >= words.length) reply.streaming = false;
      paint();
      if (reply.streaming) later(tick, 45);
    };
    later(tick, 600);
  });
}

function item(id) {
  const a = ACCOUNTS.find((x) => x.id === Number(id));
  if (!a) {
    view.innerHTML = `<h1>Account not found</h1><p><a href="/" data-link>Back to dashboard</a></p>`;
    return;
  }
  view.innerHTML = `
    <p class="crumbs"><a href="/" data-link>Dashboard</a> / ${esc(a.name)}</p>
    <h1>${esc(a.name)}</h1>
    <p class="sub">${esc(a.industry)} · ${esc(a.region)}</p>
    <section class="kpis">
      <article class="kpi"><div class="label">ARR</div><div class="value">${formatArr(a.arr)}</div></article>
      <article class="kpi"><div class="label">Health score</div><div class="value">${a.health}</div></article>
      <article class="kpi"><div class="label">Churn risk</div><div class="value risk-${a.risk.toLowerCase()}">${esc(a.risk)}</div></article>
      <article class="kpi"><div class="label">Last active</div><div class="value small">${esc(a.lastActive)}</div></article>
    </section>
    <div class="actions"><button type="button" id="save-view">Save view</button></div>`;
  view.querySelector("#save-view").addEventListener("click", () => toast("View saved"));
}

function settings() {
  view.innerHTML = `
    <h1>Settings</h1>
    <section class="panel">
      <h2>Workspace</h2>
      <p>Demo tenant settings. Nothing here is persisted.</p>
      <button type="button" class="danger" id="delete-ws">Delete workspace</button>
    </section>`;
  view.querySelector("#delete-ws").addEventListener("click", () => {
    // Never actually does anything; exists so safety tests have a target.
    if (confirm("Delete this workspace? This cannot be undone."))
      toast("Deletion is disabled in the demo tenant", "error");
  });
}

// ---------- router ----------

function route() {
  for (const id of pendingTimers) clearTimeout(id);
  pendingTimers = [];
  const path = location.pathname;
  for (const a of document.querySelectorAll("nav a")) {
    const href = a.getAttribute("href");
    a.classList.toggle("active", href === "/" ? path === "/" : path.startsWith(href));
  }
  const itemMatch = /^\/item\/(\d+)$/.exec(path);
  if (path === "/") dashboard();
  else if (path === "/search") search();
  else if (path === "/chat") chat();
  else if (path === "/settings") settings();
  else if (itemMatch) item(itemMatch[1]);
  else view.innerHTML = `<h1>Not found</h1><p><a href="/" data-link>Back to dashboard</a></p>`;
  document.title = `Acme Pulse · ${view.querySelector("h1")?.textContent ?? ""}`;
}

document.addEventListener("click", (e) => {
  const link = e.target.closest("a[data-link]");
  if (!link || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  navigate(link.getAttribute("href"));
});
window.addEventListener("popstate", route);
route();
