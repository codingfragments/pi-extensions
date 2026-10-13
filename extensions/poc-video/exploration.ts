import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
/**
 * Pass-1 exploration tools. Every browser action during exploration is a
 * first-class pi tool call — reasoning streams in-session, the user sees
 * every click, and the session log doubles as the exploration record.
 *
 * Tool surface (collision-resistant poc_video_ prefix):
 *   poc_video_open        launch persistent headed Chromium, open the start URL
 *   poc_video_navigate    go to a URL
 *   poc_video_click       click a selector
 *   poc_video_type        type text into a selector (instant — human-like input is pass-2 only)
 *   poc_video_press       press a keyboard key
 *   poc_video_screenshot  save scenes/<name>.png (pass-1 reference shots)
 *   poc_video_state       current URL + page title (cheap observation)
 *   poc_video_close       close the browser
 */
import { Type } from "typebox";
import { closeBrowser, openBrowser, requirePage, requireRunDir } from "./browser.ts";

const text = (t: string) => ({
  content: [{ type: "text", text: t }] as { type: "text"; text: string }[],
  details: {},
});

const SEL_DOC =
  "Playwright selector: role=button[name='New project'], text=Login, or any CSS selector";

export function registerExplorationTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "poc_video_open",
    label: "POC video: open browser",
    description:
      "Launch a persistent headed Chromium (1920×1080) and open the start URL. " +
      "The user then logs in manually — NEVER continue until the user says they are ready. " +
      "The persistent profile lives under the run dir and is reused for retakes.",
    parameters: Type.Object({
      run_dir: Type.String({
        description: "run directory for this target (e.g. pocs/turso) — must exist",
      }),
      url: Type.String({ description: "start URL to open" }),
      headless: Type.Optional(
        Type.Boolean({ description: "run headless (smoke tests only — real runs are headed)" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const runDir = path.resolve(params.run_dir);
      if (!fs.existsSync(runDir)) {
        throw new Error(
          `run dir ${runDir} does not exist — create it first: ` +
            `node extensions/poc-video/scripts/pass1-init.ts <target>`,
        );
      }
      const state = await openBrowser({ runDir, url: params.url, headless: params.headless });
      return text(
        `browser open at ${state.page.url()}\nrun dir: ${state.runDir}\n` +
          "STOP: wait for the user to log in manually and confirm they are on the start page, then continue exploration.",
      );
    },
  });

  pi.registerTool({
    name: "poc_video_navigate",
    label: "POC video: navigate",
    description: "Navigate the exploration browser to a URL.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to open" }),
    }),
    async execute(_toolCallId, params) {
      const page = requirePage();
      await page.goto(params.url, { waitUntil: "domcontentloaded" });
      return text(`navigated to ${page.url()}`);
    },
  });

  pi.registerTool({
    name: "poc_video_click",
    label: "POC video: click",
    description: `Click an element. ${SEL_DOC}.`,
    parameters: Type.Object({
      selector: Type.String({ description: SEL_DOC }),
    }),
    async execute(_toolCallId, params) {
      const page = requirePage();
      await page.click(params.selector, { timeout: 10_000 });
      return text(`clicked: ${params.selector}\nnow at: ${page.url()}`);
    },
  });

  pi.registerTool({
    name: "poc_video_type",
    label: "POC video: type",
    description:
      "Type text into an element (instant, exploration-speed — human-like input belongs to pass-2 recording).",
    parameters: Type.Object({
      selector: Type.String({ description: SEL_DOC }),
      text: Type.String({ description: "text to type" }),
    }),
    async execute(_toolCallId, params) {
      const page = requirePage();
      await page.fill(params.selector, params.text, { timeout: 10_000 });
      return text(`typed ${params.text.length} chars into: ${params.selector}`);
    },
  });

  pi.registerTool({
    name: "poc_video_press",
    label: "POC video: press key",
    description: "Press a keyboard key (Enter, Escape, Tab, ArrowDown, …).",
    parameters: Type.Object({
      key: Type.String({ description: "key name, e.g. Enter" }),
    }),
    async execute(_toolCallId, params) {
      const page = requirePage();
      await page.keyboard.press(params.key);
      return text(`pressed ${params.key}`);
    },
  });

  pi.registerTool({
    name: "poc_video_screenshot",
    label: "POC video: screenshot",
    description:
      "Save a reference screenshot to <run_dir>/scenes/<name>.png — these become the " +
      "reference_screenshot entries in storyboard.yaml and the checkpoint-1 review images. " +
      "Use kebab-case names matching the scene id you envision.",
    parameters: Type.Object({
      name: Type.String({ description: "kebab-case name, e.g. intro-dashboard" }),
      full_page: Type.Optional(
        Type.Boolean({ description: "capture the full page, not just the viewport" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const page = requirePage();
      const runDir = requireRunDir();
      const scenesDir = path.join(runDir, "scenes");
      fs.mkdirSync(scenesDir, { recursive: true });
      const file = path.join(scenesDir, `${params.name}.png`);
      await page.screenshot({ path: file, fullPage: params.full_page ?? false });
      return text(
        `saved ${path.relative(process.cwd(), file)} (${page.url()})\n` +
          `note for storyboard drafting: reference_screenshot: scenes/${params.name}.png`,
      );
    },
  });

  pi.registerTool({
    name: "poc_video_state",
    label: "POC video: page state",
    description: "Report the current URL and page title (cheap observation — no screenshot).",
    parameters: Type.Object({}),
    async execute() {
      const page = requirePage();
      const title = await page.title();
      return text(`url: ${page.url()}\ntitle: ${title}`);
    },
  });

  pi.registerTool({
    name: "poc_video_close",
    label: "POC video: close browser",
    description: "Close the exploration browser (profile is kept for retakes).",
    parameters: Type.Object({}),
    async execute() {
      await closeBrowser();
      return text("browser closed (profile kept under the run dir)");
    },
  });
}
