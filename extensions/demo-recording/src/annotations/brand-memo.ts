/**
 * The brand of a preview, prepared once per burst (item 19, R3-19). Measured on a real project (98 annotations): a thumbnail whose picture already exists took 140 ms,
 * of which 130 ms was `prepareBrand` (the take's keyframes, the brand and its assets, hashed again for every thumbnail), and a screen of thumbnails asks for it once
 * each. The result is kept for a few seconds, shared by whoever asks meanwhile, and dropped when a brand is saved or switched.
 */

import { onBrandChanged } from "../brand/changed.ts";
import type { DemoRecConfig } from "../config.ts";
import { prepareBrand } from "../edit/pipeline.ts";

export const BRAND_MEMO_MS = 10_000;

type Prepared = Awaited<ReturnType<typeof prepareBrand>>;

const memo = new Map<string, { at: number; made: Promise<Prepared> }>();
export const brandMemoStats = { made: 0, reused: 0 };

onBrandChanged(() => memo.clear());

/** A brand was saved, duplicated or switched: the next preview prepares it again. */
export function clearPreparedBrands(): void {
  memo.clear();
}

export function prepareBrandMemo(
  projectDir: string,
  config: DemoRecConfig,
  take: string,
  brandName: string,
  now = Date.now(),
  /** How the brand is prepared (tests give a stub: preparing needs a browser). */
  make: typeof prepareBrand = prepareBrand,
): Promise<Prepared> {
  for (const [k, v] of memo) if (now - v.at > BRAND_MEMO_MS) memo.delete(k);
  const key = JSON.stringify([projectDir, config.root, take, brandName, config.output]);
  const hit = memo.get(key);
  if (hit) {
    brandMemoStats.reused++;
    return hit.made;
  }
  brandMemoStats.made++;
  const made = make(projectDir, config, take, brandName);
  memo.set(key, { at: now, made });
  made.catch(() => {
    if (memo.get(key)?.made === made) memo.delete(key);
  });
  return made;
}
