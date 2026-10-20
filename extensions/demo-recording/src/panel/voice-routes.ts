/**
 * Voice direction and "Generate voice, edit and a draft to watch" (S5 part 11, D82–D84).
 *
 *   POST vo-direction  { version, stance?, tone?, length?, focus?, notes?, saveDefault? }
 *        → a pending direction (consumed by the agent's next VO version, which
 *          stores it as its base), an input (kind nudge), optionally the brief's
 *          "Voice direction", and a message that starts the agent's turn.
 *   POST vo-generate   { version, confirm? }
 *        → without confirm: the cost estimate (no synthesis); with confirm: TTS,
 *          then the edit and its draft render, as engine jobs (no agent turn).
 */

import fs from "node:fs";
import path from "node:path";
import { formatConfidence } from "../confidence/level.ts";
import { voConfidence } from "../confidence/vo.ts";
import { reportAs } from "../roles.ts";
import { PANEL_PREFIX } from "../roles.ts";
import type { Runtime } from "../runtime.ts";
import { startEdit } from "../tools/edit.ts";
import { startTts } from "../tools/tts.ts";
import { formatEstimate, voiceEstimate } from "../tts/estimate.ts";
import { buildEngines } from "../tts/factory.ts";
import { firstLine } from "../util/events.ts";
import { type VoDirection, readVo, writePendingDirection } from "../vo/store.ts";
import { STANCES, briefFieldValue, setBriefFacts } from "../workdir/brief.ts";
import { recordInput } from "../workdir/inputs.ts";
import { readState, requireSelected } from "../workdir/state.ts";
import { writeNextVersion } from "../workdir/versioning.ts";
import type { PostRoute } from "./server.ts";

export const TONES = ["calm", "energetic", "conversational", "crisp"] as const;
export const LENGTHS = ["shorter", "same", "longer", "fit"] as const;

const LENGTH_TEXT: Record<(typeof LENGTHS)[number], string> = {
  shorter: "about 20 % shorter",
  same: "about the same length",
  longer: "about 20 % longer",
  fit: "fit the footage: per scene, speech close to the usable footage",
};

/** "stance: evaluator · tone: calm · length: same · focus: … · notes: …" (the brief's Voice direction). */
export function formatDirection(d: VoDirection): string {
  return (["stance", "tone", "length", "focus", "notes"] as const)
    .filter((k) => d[k])
    .map((k) => `${k}: ${String(d[k]).replace(/\s*·\s*/g, ", ")}`)
    .join(" · ");
}

export function parseDirection(text: string | undefined): VoDirection {
  const out: VoDirection = {};
  for (const part of (text ?? "").split(/\s+·\s+/)) {
    const m = /^(stance|tone|length|focus|notes):\s*(.+)$/i.exec(part.trim());
    if (m) out[(m[1] as string).toLowerCase() as keyof VoDirection] = (m[2] as string).trim();
  }
  return out;
}

export function validateDirection(body: Record<string, unknown>): VoDirection {
  const d: VoDirection = {};
  const pick = <T extends string>(k: keyof VoDirection, allowed: readonly T[]) => {
    const v = body[k];
    if (v === undefined || v === null || v === "") return;
    if (typeof v !== "string" || !allowed.includes(v as T))
      throw new Error(`"${k}" must be one of ${allowed.join(", ")}`);
    d[k] = v;
  };
  pick("stance", STANCES);
  pick("tone", TONES);
  pick("length", LENGTHS);
  for (const k of ["focus", "notes"] as const) {
    const v = body[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") throw new Error(`"${k}" must be text`);
    if (v.length > 600) throw new Error(`"${k}" is too long (600 characters max)`);
    if (v.trim()) d[k] = v.trim();
  }
  if (!Object.keys(d).length)
    throw new Error("pick at least one direction (stance, tone, length, focus or notes)");
  return d;
}

/** The direction as an instruction for the agent's rewrite. */
export function directionText(d: VoDirection): string {
  return [
    d.stance ? `stance: ${d.stance}` : "",
    d.tone ? `tone: ${d.tone}` : "",
    d.length ? `length: ${LENGTH_TEXT[d.length as (typeof LENGTHS)[number]] ?? d.length}` : "",
    d.focus ? `focus: "${d.focus}"` : "",
    d.notes ? `notes: "${d.notes}"` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function voiceRoutes(rt: Runtime): { post: Record<string, PostRoute> } {
  const requireProject = () => {
    const p = rt.activeProject();
    if (!p) throw new Error("no active project");
    return p;
  };
  const briefOf = (dir: string) =>
    fs.existsSync(path.join(dir, "brief.md"))
      ? fs.readFileSync(path.join(dir, "brief.md"), "utf8")
      : "";
  const versionOf = (body: Record<string, unknown>) => {
    const v = Number(body.version);
    if (!Number.isInteger(v) || v < 1) throw new Error('"version" is required');
    return v;
  };

  return {
    post: {
      "vo-direction": (body) => {
        const p = requireProject();
        const version = versionOf(body);
        const vo = readVo(p.dir, version);
        if (!vo) throw new Error(`voice-over v${version} does not exist`);
        const d = validateDirection(body);
        writePendingDirection(p.dir, version, d);
        const text = directionText(d);
        recordInput(p.dir, {
          stage: "vo",
          version,
          source: "panel",
          kind: "nudge",
          text: `voice direction on v${version}: ${text}`,
        });
        let briefVersion: number | undefined;
        if (body.saveDefault === true) {
          const before = briefOf(p.dir);
          const after = setBriefFacts(before, { voiceDirection: formatDirection(d) });
          if (after !== before) {
            const v = writeNextVersion(path.join(p.dir, "brief"), "v", ".md", after);
            fs.writeFileSync(path.join(p.dir, "brief.md"), after);
            briefVersion = v.version;
            recordInput(p.dir, {
              stage: "brief",
              version: v.version,
              source: "panel",
              kind: "brief",
              text: `default voice direction saved → brief v${v.version}: ${formatDirection(d)}`,
              refs: [`brief/v${v.version}.md`],
            });
            rt.bus.publish(
              "brief.written",
              {
                version: v.version,
                by: "user",
                changed: ["voiceDirection"],
                message: `brief v${v.version} (default voice direction)`,
              },
              p.slug,
            );
          }
        }
        rt.bus.publish(
          "vo.direction",
          {
            version,
            by: "user",
            direction: d,
            ...(briefVersion ? { briefVersion } : {}),
            message: `voice direction on v${version} → the agent drafts a new version (${text.slice(0, 80)}${text.length > 80 ? "…" : ""})`,
          },
          p.slug,
        );
        const conf = voConfidence(p.dir, version);
        rt.notifyAgent(
          `${PANEL_PREFIX} The user gave a VOICE DIRECTION for project "${p.slug}": rewrite voice-over v${version} (${vo.validated.script.take}) as a NEW COMPLETE VERSION from the same take. ` +
            `Direction — ${text}.${briefVersion ? ` (Saved as the project's default direction, brief v${briefVersion}.)` : ""} ` +
            `Use the demo-voiceover skill: demo_rec_vo get version=${version}, then write the whole script again with demo_rec_vo write (it is stored as based on v${version}; the user reviews the word diff in the Voice tab). ` +
            `Keep every [@mark] anchor valid and quote real page values.${conf?.needEyes ? `\nCurrent ${formatConfidence(conf, "section")}` : ""}`,
        );
        return { pending: true, base: version, direction: d, briefVersion: briefVersion ?? null };
      },

      "vo-generate": async (body) => {
        const p = requireProject();
        const version = versionOf(body);
        const { estimate } = await voiceEstimate(rt, version);
        if (body.confirm !== true)
          return { planned: true, estimate, summary: formatEstimate(estimate) };
        if (rt.jobs.running("tts")) throw new Error("a voice job is already running");
        if (rt.jobs.running("edit")) throw new Error("an edit is already running");
        const job = startTts(rt, version, {
          by: "panel",
          quietReport: true,
          afterDone: (j) => {
            if (!j.result) return;
            try {
              const e = startEdit(rt, "start");
              rt.bus.publish(
                "edit.started",
                {
                  job: e.id,
                  by: "panel",
                  voVersion: version,
                  message: `edit of VO v${version} started (after the voice)`,
                },
                p.slug,
              );
            } catch (err) {
              rt.bus.publish(
                "edit.finished",
                {
                  status: "failed",
                  error: (err as Error).message,
                  message: `edit couldn't start: ${firstLine((err as Error).message)}`,
                },
                p.slug,
              );
              rt.tellAgent(
                `${reportAs("Cutter")} The panel's edit after voice v${version} couldn't start: ${(err as Error).message}`,
              );
            }
          },
        });
        rt.bus.publish(
          "tts.started",
          {
            job: job.id,
            by: "panel",
            voVersion: version,
            estimate,
            message: `voice v${version} started from the panel · ${formatEstimate(estimate)}`,
          },
          p.slug,
        );
        rt.tellAgent(
          `${PANEL_PREFIX} The user started "Generate voice, edit and a draft to watch" for voice-over v${version} in the panel (${formatEstimate(estimate)}). Voice synthesis, the edit and its draft render run as engine jobs; you'll get the edit report when they are done — don't start them yourself.`,
        );
        return { job: job.id, estimate };
      },
    },
  };
}

export const defaultDirection = (brief: string) =>
  parseDirection(briefFieldValue(brief, "Voice direction"));
