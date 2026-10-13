// Types for the fixture's seeded data (data.js is plain JS served to the browser).

export interface Kpi {
  id: string;
  label: string;
  value: string;
  delta: string;
  trend: "up" | "down";
}
export interface RegionChurn {
  region: string;
  code: string;
  churn: number;
  accounts: number;
}
export interface Account {
  id: number;
  name: string;
  region: string;
  industry: string;
  arr: number;
  health: number;
  risk: "High" | "Medium" | "Low";
  lastActive: string;
}
export interface AssistantAnswer {
  keywords: string[];
  answer: string;
}

export const KPIS: Kpi[];
export const CHURN_BY_REGION: RegionChurn[];
export const ACCOUNTS: Account[];
export const ASSISTANT_ANSWERS: AssistantAnswer[];
export const ASSISTANT_FALLBACK: string;
export function formatArr(value: number): string;
