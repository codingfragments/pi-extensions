// The "Logo bug" option of a render, explained (F28). Pure, so a test can import it without the panel's modules.
// A brand shows its logo bug only when it has it turned on AND a logo file (src/brand/assets.ts `logoBugStatus`); the checkbox is useless otherwise.

const CORNER = {
  "top-left": "top left",
  "top-right": "top right",
  "bottom-left": "bottom left",
  "bottom-right": "bottom right",
};

/**
 * What to say about the logo bug for the brands chosen for a render. `brands` is the render page's list ({ name, logoBug: { state, position? } }),
 * `chosen` the names ticked. `disabled` means no chosen brand would show it, so the checkbox has nothing to do.
 */
export function logoBugNote(brands, chosen) {
  const picked = chosen.map((n) => brands.find((b) => b.name === n)).filter(Boolean);
  if (!picked.length)
    return { disabled: true, text: "Choose a look first: the logo bug belongs to the brand." };
  const shows = picked.filter((b) => b.logoBug?.state === "shows");
  const why = (b) =>
    b.logoBug?.state === "no-logo"
      ? `${b.name} has it turned on but no logo file`
      : `${b.name} has it turned off`;
  const short = (b) =>
    `${b.name} (${b.logoBug?.state === "no-logo" ? "no logo file" : "turned off"})`;
  const without = picked.filter((b) => b.logoBug?.state !== "shows");
  if (!shows.length)
    return {
      disabled: true,
      text: `Nothing to show: ${without.map(why).join("; ")}. The logo bug is a small logo in a corner of the full video; the brand decides if there is one.`,
      fix: true,
    };
  const where = [...new Set(shows.map((b) => CORNER[b.logoBug.position] ?? b.logoBug.position))];
  return {
    disabled: false,
    text: `Puts the brand's logo in the ${where.join(" / ")} corner of the full video (${shows.map((b) => b.name).join(", ")}).${without.length ? ` Not shown for ${without.map(short).join(", ")}.` : ""}`,
    fix: without.length > 0,
  };
}
