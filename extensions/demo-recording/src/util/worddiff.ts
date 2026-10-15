/**
 * Word-level diff (D83): the panel shows a re-directed voice-over section's
 * insertions and deletions against its base. LCS over word tokens; runs of
 * the same operation are merged, separators are kept with the words.
 */

export interface DiffPart {
  op: "eq" | "ins" | "del";
  text: string;
}

const tokens = (s: string) => s.trim().split(/\s+/).filter(Boolean);

export function wordDiff(before: string, after: string): DiffPart[] {
  const a = tokens(before);
  const b = tokens(after);
  // LCS lengths from the end (n·m; sections are short — a few hundred words at most).
  const n = a.length;
  const m = b.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      (L[i] as number[])[j] =
        a[i] === b[j]
          ? ((L[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((L[i + 1] as number[])[j] as number, (L[i] as number[])[j + 1] as number);
  const out: DiffPart[] = [];
  const push = (op: DiffPart["op"], w: string) => {
    const last = out.at(-1);
    if (last && last.op === op) last.text += ` ${w}`;
    else out.push({ op, text: w });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("eq", a[i] as string);
      i++;
      j++;
    } else if (((L[i + 1] as number[])[j] as number) >= ((L[i] as number[])[j + 1] as number))
      push("del", a[i++] as string);
    else push("ins", b[j++] as string);
  }
  while (i < n) push("del", a[i++] as string);
  while (j < m) push("ins", b[j++] as string);
  return out;
}

export const changed = (parts: DiffPart[]) => parts.some((p) => p.op !== "eq");
