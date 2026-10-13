/**
 * Minimal ambient types for @playwright-labs/ghost-cursor 1.0.0.
 *
 * The package's exports map points import-condition types at
 * `dist/index.d.mts`, which does not exist in the published tarball —
 * TypeScript therefore cannot resolve its types (TS7016). This shim
 * declares exactly the surface human.ts uses. Remove it if the package
 * fixes its exports map.
 */
declare module "@playwright-labs/ghost-cursor" {
  import type { Page, ElementHandle } from "playwright";

  export interface Vector {
    x: number;
    y: number;
  }

  export interface CreateCursorOptions {
    /** Initial cursor position. Defaults to `{ x: 0, y: 0 }`. */
    start?: Vector;
    /** Continuously move the cursor to random positions when idle. */
    performRandomMoves?: boolean;
    /** Show a visual debug overlay following the cursor. */
    visible?: boolean;
  }

  export class GhostCursor {
    readonly page: Page;
    click(selector?: string | ElementHandle, options?: Record<string, unknown>): Promise<void>;
    move(selector: string | ElementHandle, options?: Record<string, unknown>): Promise<void>;
    moveTo(destination: Vector, options?: Record<string, unknown>): Promise<void>;
    getLocation(): Vector;
  }

  export function createCursor(page: Page, options?: CreateCursorOptions): GhostCursor;

  /**
   * Injects a pointer overlay (`<p-mouse-pointer>`) that follows the cursor.
   * Applied via addInitScript — effective from the NEXT navigation on.
   */
  export function installMouseHelper(
    page: Page,
  ): Promise<{ removeMouseHelper: () => Promise<void> }>;
}
