/**
 * Open a URL in the user's default browser (`/demo panel`). Best effort,
 * never throws: macOS `open`, Windows `start`, Linux/BSD `xdg-open`.
 * Disabled with DEMO_REC_NO_OPEN=1 (tests, CI, SSH sessions without a desktop).
 */

import { spawn } from "node:child_process";

export function browserCommand(platform: NodeJS.Platform = process.platform): {
  cmd: string;
  args: (url: string) => string[];
} {
  if (platform === "darwin") return { cmd: "open", args: (u) => [u] };
  if (platform === "win32") return { cmd: "cmd", args: (u) => ["/c", "start", '""', u] };
  return { cmd: "xdg-open", args: (u) => [u] };
}

export function canOpenBrowser(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (env.DEMO_REC_NO_OPEN === "1" || env.CI) return false;
  // Linux without a desktop session (SSH, containers): nothing to open.
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  return true;
}

/** Returns true when an opener was started (the browser may still fail on its own). */
export function openInBrowser(url: string): boolean {
  if (!canOpenBrowser()) return false;
  const { cmd, args } = browserCommand();
  try {
    const child = spawn(cmd, args(url), { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
