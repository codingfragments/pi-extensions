// The package ships types, but its package.json "exports" hides them from
// moduleResolution "Bundler". We only use the pure `path` geometry helper.
declare module "@playwright-labs/ghost-cursor" {
  export interface Vector {
    x: number;
    y: number;
  }
  export function path(
    start: Vector,
    end: Vector | (Vector & { width: number; height: number }),
    options?: number | { spreadOverride?: number; moveSpeed?: number; useTimestamps?: boolean },
  ): Vector[];
}
