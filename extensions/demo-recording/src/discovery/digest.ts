/**
 * The aria digest a look returns to the Director. The page's navigation (the same few hundred characters of "Primary Navigation", "Secondary Navigation", the header)
 * was sent again with every look and used up the 6000-character limit before the page's own content began. A landmark that is identical to the one of the last look
 * is replaced by one line; its targets were in the earlier digest, and the full snapshot is still on disk (dom/sNNN.yaml) and used for target checks.
 */

/** Landmarks that are page chrome rather than content. */
const CHROME = /^- (navigation|banner|complementary|contentinfo|search)\b/;

/** The top-level items of an aria snapshot: each starts at column 0 with "- " and runs to the next one. */
export function topBlocks(raw: string): string[] {
  const blocks: string[] = [];
  let cur: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("- ") && cur.length) {
      blocks.push(cur.join("\n"));
      cur = [];
    }
    cur.push(line);
  }
  if (cur.length) blocks.push(cur.join("\n"));
  return blocks;
}

const keyOf = (block: string) => (block.split("\n", 1)[0] ?? "").replace(/:\s*$/, "");

export interface ReducedDigest {
  text: string;
  /** The landmarks that were left out because they have not changed, by their first line. */
  collapsed: string[];
}

/**
 * `previous` maps a landmark's first line to its full text as of the last look; it is updated here to this look's. The first look, and `full`, leave everything in.
 */
export function reduceDigest(
  raw: string,
  previous: Map<string, string>,
  full = false,
): ReducedDigest {
  const collapsed: string[] = [];
  const out: string[] = [];
  const seen = new Map<string, string>();
  for (const block of topBlocks(raw)) {
    const first = block.split("\n", 1)[0] ?? "";
    if (CHROME.test(first)) {
      const key = keyOf(block);
      seen.set(key, block);
      if (!full && previous.get(key) === block) {
        const lines = block.split("\n").length;
        out.push(
          `${key}: (unchanged since the last look, ${lines} lines; its targets are still valid)`,
        );
        collapsed.push(key);
        continue;
      }
    }
    out.push(block);
  }
  previous.clear();
  for (const [k, v] of seen) previous.set(k, v);
  return { text: out.join("\n"), collapsed };
}
