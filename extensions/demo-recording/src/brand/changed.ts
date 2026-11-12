/** A brand was created, changed or copied: whatever kept something prepared from the brands on disk lets it go (the previews' brand memo). */

const listeners = new Set<() => void>();

export function onBrandChanged(fn: () => void): void {
  listeners.add(fn);
}

export function notifyBrandChanged(): void {
  for (const fn of listeners) fn();
}
