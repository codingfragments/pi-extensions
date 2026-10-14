/**
 * Working-directory layout (IMPLEMENTATION_PLAN §3.1, decision D16).
 *
 *   <root>/apps/<app>/        shared per app: app.json, auth/, policy.json, discovery/
 *   <root>/projects/<proj>/   one demo: brief.md, context/, state.json, storyboard/,
 *                             takes/, vo/, edit/, out/
 */

import fs from "node:fs";
import path from "node:path";
import { type ProjectState, createInitialState, readState, writeState } from "./state.ts";

export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  if (!slug) throw new Error(`cannot derive a slug from ${JSON.stringify(input)}`);
  return slug;
}

export const appsDir = (root: string) => path.join(root, "apps");
export const projectsDir = (root: string) => path.join(root, "projects");
export const appDir = (root: string, app: string) => path.join(appsDir(root), app);
export const projectDir = (root: string, project: string) => path.join(projectsDir(root), project);

const PROJECT_SUBDIRS = ["context", "storyboard", "takes", "vo", "edit", "out", "jobs"] as const;
const APP_SUBDIRS = ["auth", "discovery"] as const;

export interface AppInfo {
  slug: string;
  name: string;
  baseUrl: string;
  createdAt: string;
}

export function readApp(root: string, app: string): AppInfo | undefined {
  const file = path.join(appDir(root, app), "app.json");
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")) as AppInfo;
}

/** Create (or return) the shared per-app directory. Idempotent; never rewrites app.json. */
export function ensureApp(root: string, name: string, baseUrl: string, now = new Date()): AppInfo {
  const slug = slugify(name);
  const dir = appDir(root, slug);
  for (const sub of APP_SUBDIRS) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  // auth/ holds browser session cookies (D5): owner-only.
  fs.chmodSync(path.join(dir, "auth"), 0o700);
  const existing = readApp(root, slug);
  if (existing) return existing;
  const info: AppInfo = {
    slug,
    name,
    baseUrl: normalizeUrl(baseUrl),
    createdAt: now.toISOString(),
  };
  fs.writeFileSync(path.join(dir, "app.json"), `${JSON.stringify(info, null, 2)}\n`, {
    flag: "wx",
  });
  return info;
}

export function normalizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`not a valid URL: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`only http(s) apps are supported, got ${parsed.protocol}`);
  }
  return parsed.toString();
}

export interface NewProjectInput {
  project: string;
  appName: string;
  appUrl: string;
  /** Optional initial brief text; a stub is written otherwise (full guided brief: S2). */
  brief?: string;
}

export interface ProjectHandle {
  slug: string;
  dir: string;
  app: AppInfo;
  state: ProjectState;
  created: boolean;
}

function briefStub(input: NewProjectInput, app: AppInfo): string {
  return `# Demo brief: ${input.project}

- **App:** ${app.name}
- **URL:** ${app.baseUrl}
- **Extra URLs:** _none_
- **Title:** _TODO_
- **Subtitle:** _TODO_
- **Persona:** _TODO (who watches, what they already know)_
- **Depth:** _poc | showcase | sales_
- **Stance:** _champion | evaluator | teacher (default from depth)_
- **Goal / key message:** _TODO_
- **Target length:** _TODO (min–max, default from depth)_
- **Must show:** _TODO_
- **Must avoid:** _TODO_
- **Language:** English
- **Voice:** _TODO_

## Background

_TODO: free-form background; attach material under \`context/\`._
`;
}

/** Create a new project, or open it if it already exists (never clobbers files). */
export function ensureProject(
  root: string,
  input: NewProjectInput,
  now = new Date(),
): ProjectHandle {
  const app = ensureApp(root, input.appName, input.appUrl, now);
  const slug = slugify(input.project);
  const dir = projectDir(root, slug);
  const existing = readState(dir);
  if (existing)
    return { slug, dir, app: readApp(root, existing.app) ?? app, state: existing, created: false };

  for (const sub of PROJECT_SUBDIRS) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  const briefFile = path.join(dir, "brief.md");
  if (!fs.existsSync(briefFile)) fs.writeFileSync(briefFile, input.brief ?? briefStub(input, app));
  const state = createInitialState(slug, app.slug, now);
  writeState(dir, state);
  return { slug, dir, app, state, created: true };
}

export function openProject(root: string, project: string): ProjectHandle {
  const slug = slugify(project);
  const dir = projectDir(root, slug);
  const state = readState(dir);
  if (!state) throw new Error(`no demo project "${slug}" under ${projectsDir(root)}`);
  const app = readApp(root, state.app);
  if (!app) throw new Error(`project "${slug}" references unknown app "${state.app}"`);
  return { slug, dir, app, state, created: false };
}

export function listProjects(root: string): string[] {
  const dir = projectsDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, "state.json")))
    .map((d) => d.name)
    .sort();
}
