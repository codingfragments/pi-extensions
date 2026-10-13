// Seeded, deterministic data for the Acme Pulse fixture (D20).
// Values are fixed on purpose: tests and storyboards quote them verbatim.

export const KPIS = [
  {
    id: "arr",
    label: "Annual recurring revenue",
    value: "$4.82M",
    delta: "+6.4% QoQ",
    trend: "up",
  },
  { id: "churn", label: "Gross churn (90d)", value: "3.1%", delta: "+0.4 pts", trend: "down" },
  { id: "nps", label: "Net promoter score", value: "47", delta: "+3", trend: "up" },
  { id: "accounts", label: "Active accounts", value: "1,284", delta: "+52", trend: "up" },
];

export const CHURN_BY_REGION = [
  { region: "North America", code: "NA", churn: 2.4, accounts: 612 },
  { region: "EMEA", code: "EMEA", churn: 14.2, accounts: 341 },
  { region: "APAC", code: "APAC", churn: 5.1, accounts: 208 },
  { region: "LATAM", code: "LATAM", churn: 6.8, accounts: 123 },
];

export const ACCOUNTS = [
  {
    id: 101,
    name: "Northwind Traders",
    region: "EMEA",
    industry: "Retail",
    arr: 182000,
    health: 41,
    risk: "High",
    lastActive: "2 days ago",
  },
  {
    id: 102,
    name: "Contoso Health",
    region: "North America",
    industry: "Healthcare",
    arr: 264000,
    health: 88,
    risk: "Low",
    lastActive: "today",
  },
  {
    id: 103,
    name: "Fabrikam Logistics",
    region: "EMEA",
    industry: "Logistics",
    arr: 97000,
    health: 35,
    risk: "High",
    lastActive: "11 days ago",
  },
  {
    id: 104,
    name: "Tailspin Air",
    region: "APAC",
    industry: "Travel",
    arr: 143000,
    health: 62,
    risk: "Medium",
    lastActive: "yesterday",
  },
  {
    id: 105,
    name: "Wide World Importers",
    region: "LATAM",
    industry: "Wholesale",
    arr: 76000,
    health: 39,
    risk: "High",
    lastActive: "4 days ago",
  },
  {
    id: 106,
    name: "Litware Bank",
    region: "EMEA",
    industry: "Finance",
    arr: 310000,
    health: 47,
    risk: "High",
    lastActive: "6 days ago",
  },
  {
    id: 107,
    name: "Adventure Works",
    region: "North America",
    industry: "Outdoor",
    arr: 121000,
    health: 91,
    risk: "Low",
    lastActive: "today",
  },
  {
    id: 108,
    name: "Proseware Labs",
    region: "APAC",
    industry: "Software",
    arr: 205000,
    health: 79,
    risk: "Low",
    lastActive: "today",
  },
  {
    id: 109,
    name: "Blue Yonder Energy",
    region: "EMEA",
    industry: "Energy",
    arr: 158000,
    health: 52,
    risk: "Medium",
    lastActive: "3 days ago",
  },
  {
    id: 110,
    name: "Coho Vineyard",
    region: "North America",
    industry: "Food & Beverage",
    arr: 64000,
    health: 73,
    risk: "Low",
    lastActive: "yesterday",
  },
  {
    id: 111,
    name: "Lucerne Publishing",
    region: "EMEA",
    industry: "Media",
    arr: 88000,
    health: 38,
    risk: "High",
    lastActive: "9 days ago",
  },
  {
    id: 112,
    name: "Margie's Travel",
    region: "LATAM",
    industry: "Travel",
    arr: 54000,
    health: 66,
    risk: "Medium",
    lastActive: "2 days ago",
  },
];

/** Deterministic assistant answers, chosen by keyword (first match wins). */
export const ASSISTANT_ANSWERS = [
  {
    keywords: ["emea", "europe"],
    answer:
      "EMEA is the outlier: 14.2% gross churn over 90 days across 341 accounts, versus 2.4% in North America. Four of the five high-risk accounts sit in EMEA, led by Litware Bank ($310K ARR, health 47) and Northwind Traders ($182K ARR, health 41).",
  },
  {
    keywords: ["churn", "risk", "at risk"],
    answer:
      "Gross churn is 3.1% over the last 90 days, up 0.4 points. Five accounts are flagged high risk, representing $753K in ARR. The biggest single exposure is Litware Bank at $310K.",
  },
  {
    keywords: ["revenue", "arr", "growth"],
    answer:
      "ARR is $4.82M, up 6.4% quarter over quarter. North America contributes the largest share; APAC grew fastest, driven by Proseware Labs ($205K).",
  },
];

export const ASSISTANT_FALLBACK =
  "I can answer questions about churn, revenue and account health. Try asking which region has the highest churn.";

export function formatArr(value) {
  return value >= 1000000 ? `$${(value / 1000000).toFixed(2)}M` : `$${Math.round(value / 1000)}K`;
}
