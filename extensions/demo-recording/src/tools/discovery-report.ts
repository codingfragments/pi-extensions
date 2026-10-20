/**
 * demo_rec_discovery: the Director's side of the discovery report (item 10, D2). context: what it may cite (findings, screens, sources),
 * what the engine measured per area, the latest report and the rules. report: write the next version, which the tool REFUSES unless every
 * claim cites evidence that exists. get: read a version. It cannot write a storyboard or change a finding.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  LIMITS,
  formatReport,
  readReport,
  reportBrief,
  reportVersions,
  writeReport,
} from "../discovery/report.ts";
import type { Runtime } from "../runtime.ts";
import { appDirOf } from "../workdir/context.ts";
import { result } from "./common.ts";

const Cited = Type.Object({
  text: Type.String({ description: `what you found, at most ${LIMITS.text} characters` }),
  evidence: Type.Array(Type.String(), {
    description:
      "ids: a finding f-0004, a screen <session>/s012, or file:… ref:… input:… for a source",
  }),
});
const Guide = Type.Object({
  title: Type.String({ description: `at most ${LIMITS.title} characters` }),
  why: Type.String({ description: `at most ${LIMITS.why} characters` }),
  evidence: Type.Array(Type.String()),
});

export function registerDiscoveryReportTool(pi: ExtensionAPI, rt: Runtime): void {
  pi.registerTool({
    name: "demo_rec_discovery",
    label: "Demo discovery report",
    description:
      "The discovery report: what discovery found about the app, what the project's sources added, and the guidance for the storyboard (use cases, " +
      "must show, risks, avoid). WRITE IT at the end of every discovery (after the last look, before the storyboard), and again when the user asks for " +
      "an update. context: what you may cite, what the engine measured per area, the latest report and the rules. report: store the next version; " +
      "every item must cite evidence that exists (a finding id, a screen <session>/sNNN, a source file:/ref:/input:), and the tool refuses " +
      "an invented one and says why. Do not claim coverage: the engine fills it from what it measured. get: read a version. You cannot write the " +
      "storyboard from here.",
    parameters: Type.Object({
      action: StringEnum(["context", "report", "get"] as const),
      summary: Type.Optional(
        Type.String({
          description: `report: what discovery found, a few sentences (at most ${LIMITS.summary} characters)`,
        }),
      ),
      found: Type.Optional(
        Type.Array(Cited, {
          description: `report: ${LIMITS.found[0]}-${LIMITS.found[1]} things about the app, each citing findings or screens`,
        }),
      ),
      research: Type.Optional(
        Type.Array(Cited, {
          description:
            "report: what the sources added, each citing a source; empty when the project has none",
        }),
      ),
      guidance: Type.Optional(
        Type.Object({
          useCases: Type.Array(Guide),
          mustShow: Type.Array(Guide),
          risks: Type.Array(Guide),
          avoid: Type.Array(Guide),
        }),
      ),
      version: Type.Optional(Type.Number({ description: "get: the version (default the latest)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      rt.bindUi(ctx?.ui);
      const p = rt.requireProject();
      const app = appDirOf(p.dir, p.app.slug);
      if (params.action === "context") return result(reportBrief(p.dir, app));
      if (params.action === "get") {
        const r = readReport(p.dir, params.version);
        if (!r) return result("no discovery report yet: write one with demo_rec_discovery report");
        return result(
          `${formatReport(r, { full: true })}\n(versions: ${reportVersions(p.dir).join(", ")})`,
        );
      }
      const r = writeReport(p.dir, app, {
        summary: params.summary,
        found: params.found,
        research: params.research ?? [],
        guidance: params.guidance,
      });
      rt.bus.publish(
        "discovery.reported",
        {
          version: r.version,
          by: "agent",
          findings: r.coverage.findings,
          message: `discovery report v${r.version}: ${r.found.length} things found, ${r.guidance.useCases.length} use case${r.guidance.useCases.length === 1 ? "" : "s"}`,
        },
        p.slug,
      );
      return result(
        `Stored discovery report v${r.version}. The user reads it on the Project page (Discovery); the storyboard can now follow its guidance. Stop here unless you were asked to write the storyboard next.`,
        { version: r.version },
      );
    },
  });
}
