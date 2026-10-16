// demo-recording side panel — the control room. Preact + htm, vendored, no build.
// This file only starts the shell (shell.js); each screen has its own module.
import { html, render } from "/vendor/preact-htm.module.js";
import { App } from "./shell.js";

render(html`<${App} />`, document.getElementById("app"));
