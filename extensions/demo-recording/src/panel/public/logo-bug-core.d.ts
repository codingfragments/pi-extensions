export interface LogoBugBrand {
  name: string;
  logoBug?: { state: "shows" | "off" | "no-logo"; position?: string };
}
export function logoBugNote(
  brands: LogoBugBrand[],
  chosen: string[],
): { disabled: boolean; text: string; fix?: boolean };
