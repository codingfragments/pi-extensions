// The pure part of the staged-edits store (no browser imports, so tests can load it): one staged value per setting and scope.
export const stageId = (scope, key) => `${scope}:${key}`;

/** The list with this change in it: one staged value per setting and scope, a newer one replaces the older. */
export function withChange(list, item) {
  const id = stageId(item.scope, item.key);
  const next = list.filter((x) => x.id !== id);
  next.push({ ...item, id });
  return next;
}

export const without = (list, id) => list.filter((x) => x.id !== id);

/** The body of a /api/config-batch call. */
export const toBatch = (list) =>
  list.map((x) => ({
    key: x.key,
    scope: x.scope,
    ...(x.unset ? { unset: true } : { value: x.value }),
  }));

/** What the leaving dialog and the bar say: "3 changes". */
export const countWord = (n) => `${n} change${n === 1 ? "" : "s"}`;
