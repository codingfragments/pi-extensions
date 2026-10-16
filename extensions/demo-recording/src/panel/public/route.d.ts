export const SCREENS: string[];
export interface Route {
  screen: string;
  version?: number;
  item?: string;
  query: Record<string, string>;
  raw: string;
  valid: boolean;
  reason?: string;
}
export function parseRoute(hash: string | null | undefined): Route | null;
export function formatRoute(route?: {
  screen?: string;
  version?: number;
  item?: string;
  query?: Record<string, string | undefined>;
}): string;
export function readLastPlace(slug: string, storage?: Pick<Storage, "getItem">): Route | null;
export function writeLastPlace(
  slug: string,
  route: Route | null,
  storage?: Pick<Storage, "setItem">,
): void;
