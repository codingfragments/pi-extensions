export type Stage = "storyboard" | "recording" | "vo" | "annotations" | "render";
export interface GNode {
  id: string;
  kind: "version" | "drafts" | "qa" | "more";
  stage: Stage;
  version?: number;
  label: string;
  short: string;
  meta: string;
  approved: boolean;
  usable: boolean;
  blocked: string | null;
  inLine: boolean;
  draft: boolean;
  review: "waiting" | null;
  availability: string;
  unknownLink: string | null;
  at: string | null;
  render?: {
    kind: "draft" | "final";
    status: string;
    variants: { key: string; brand: string; bytes: number; present: boolean }[];
    size: { width: number; height: number };
  };
  qa?: { status: string; blocking: number; warnings: number; confirmed: number };
  members?: string[];
  group?: string;
  parentOf?: string;
}
export interface GEdge {
  from: string;
  to: string;
  rel: "depends-on" | "contains";
  direct?: boolean;
}
export interface GGraph {
  project: string;
  line: Partial<Record<Stage, string>>;
  stages: { stage: Stage; label: string }[];
  nodes: GNode[];
  edges: GEdge[];
  rev: string;
  generatedAt: string;
}
export interface MapState {
  view: "all" | "approved" | "line";
  q: string;
  sel: string | null;
  focus: boolean;
  open: Set<string>;
}
export interface Index {
  byId: Map<string, GNode>;
  parents: Map<string, string[]>;
  kids: Map<string, string[]>;
  owner: Map<string, string>;
}
export interface Item extends GNode {
  match: boolean;
  dim: boolean;
}
export interface Placed extends Item {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Layout {
  nodes: Placed[];
  edges: {
    from: string;
    to: string;
    rel: string;
    d: string;
    line: boolean;
    dim: boolean;
    unknown: boolean;
    direct: boolean;
  }[];
  col: number;
  nodeW: number;
  width: number;
  height: number;
  heads: { stage: Stage; count: number }[];
}
export const MAP_VIEWS: string[];
export const GROUP_CAP: number;
export const STAGE_SCREEN: Record<string, string>;
export const STAGE_NAME: Record<string, string>;
export const LAYOUT: {
  pad: number;
  nodeH: number;
  qaH: number;
  gap: number;
  minCol: number;
  maxCol: number;
  qaGap: number;
};
export function mapStateFromRoute(
  route: { query?: Record<string, string> } | null | undefined,
): MapState;
export function mapQueryFromState(s: MapState): Record<string, string>;
export function mapRouteFor(id: string): { screen: "map"; query: Record<string, string> };
export function readMapMemory(
  slug: string,
  storage?: Pick<Storage, "getItem">,
): { view: MapState["view"]; open: Set<string> } | null;
export function writeMapMemory(
  slug: string,
  s: Pick<MapState, "view" | "open">,
  storage?: Pick<Storage, "setItem">,
): void;
export function indexGraph(g: GGraph): Index;
export function ancestorsOf(ix: Index, id: string): string[];
export function descendantsOf(ix: Index, id: string): string[];
export function matches(n: GNode, q: string, members?: GNode[]): boolean;
export function visibleNodes(
  g: GGraph,
  ix: Index,
  s: MapState,
): {
  shown: Map<string, { match: boolean; dim: boolean }>;
  items: Item[];
  hidden: number;
  groups: { id: string; open: boolean; count: number }[];
};
export function layoutMap(
  g: GGraph,
  ix: Index,
  items: Item[],
  width: number,
  heights?: Map<string, number>,
): Layout;
export function outlineOf(ix: Index, items: Item[]): { node: Item; children: unknown[] }[];
export function neighbour(ix: Index, layout: Layout, id: string, key: string): string | null;
export function detailsOf(
  g: GGraph,
  ix: Index,
  id: string,
): {
  node: GNode;
  built: GNode[];
  broken: GNode | null;
  direct: boolean;
  open: { screen: string; version: number | undefined; label: string };
} | null;
export function hiddenSelection(
  g: GGraph,
  ix: Index,
  s: MapState,
  items: Item[],
): { id: string; missing: boolean; label: string; why?: string } | null;
