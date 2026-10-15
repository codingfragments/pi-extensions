/**
 * The DRAFT tag for draft renders (S5 part 9, D60): a small pill in a corner
 * of the frame — never across the picture — in the brand's font and colours,
 * away from the logo bug's corner. Rendered once per size + brand (cached).
 */

import path from "node:path";
import { type PngJob, renderPngs } from "../annotations/render.ts";
import type { LoadedBrand } from "../brand/brand.ts";

export async function draftStamp(
  brand: LoadedBrand,
  size: { width: number; height: number },
  cacheDir: string,
  /** The logo bug's corner, if it is shown (the tag takes another corner). */
  avoid?: string,
): Promise<{ file: string; x: number; y: number }> {
  const s = size.height / 1080;
  const b = brand.brand;
  const pad = Math.round(14 * s);
  const job: PngJob = {
    key: "draft",
    w: Math.round(400 * s),
    h: Math.round(120 * s),
    clipSelector: "#tag",
    html: `<!doctype html><html><body style="margin:0;background:transparent;font-family:${b.font.family}"><div id="tag" style="display:inline-block;margin:4px;padding:${Math.round(6 * s)}px ${Math.round(14 * s)}px;border-radius:${Math.round(8 * s)}px;background:rgba(0,0,0,.55);color:#fff;font-size:${Math.max(11, Math.round(22 * s))}px;font-weight:700;letter-spacing:.12em;border:${Math.max(1, Math.round(2 * s))}px solid ${b.colors.accent}">DRAFT</div></body></html>`,
  };
  const png = (await renderPngs([job], path.join(cacheDir))).get("draft");
  if (!png) throw new Error("could not render the DRAFT tag");
  const right = avoid !== "top-right";
  return { file: png.file, x: right ? size.width - png.w - pad : pad, y: pad };
}
