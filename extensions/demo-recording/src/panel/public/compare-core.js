// The pure part of the compare window (no browser imports, so tests can load it).
/** The default pair: the production line's version against the one you are viewing (else the newest other one). */
export function defaultPair(rows, viewed) {
  const versions = rows.map((r) => r.version);
  const line = rows.find((r) => r.inLine)?.version;
  const b =
    viewed !== null && viewed !== undefined && versions.includes(viewed) ? viewed : versions.at(-1);
  const a =
    line !== undefined && line !== b
      ? line
      : (versions.filter((v) => v !== b).at(-1) ?? versions[0]);
  return [a, b];
}
