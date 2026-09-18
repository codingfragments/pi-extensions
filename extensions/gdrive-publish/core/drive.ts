/**
 * Drive access, behind a narrow interface so tests can substitute a fake.
 *
 * Every call here was exercised by the spike (`spike/probe.ts`); notably the
 * two-phase mechanic: create an empty Doc, then `files.update` with media to
 * fill it while keeping the fileId (and therefore the shared URL) stable.
 */

import crypto from "node:crypto";
import { GOOGLE_DOC, GOOGLE_FOLDER } from "./types.ts";

const API = "https://www.googleapis.com";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  trashed?: boolean;
  modifiedTime?: string;
  lastModifyingUser?: { displayName?: string; emailAddress?: string };
}

/** The only Drive surface core logic is allowed to use. */
export interface DriveClient {
  createFolder(name: string, parentId?: string): Promise<DriveFile>;
  createEmptyDoc(name: string, parentId: string): Promise<DriveFile>;
  /** Convert-on-upload: metadata mimeType is the Google type, media is the source. */
  convertUpload(
    name: string,
    targetMime: string,
    mediaMime: string,
    data: Buffer | string,
    parentId: string,
  ): Promise<DriveFile>;
  /** Replace the content of an existing file, keeping its id. */
  updateMedia(fileId: string, mediaMime: string, data: Buffer | string): Promise<void>;
  rename(fileId: string, name: string): Promise<void>;
  get(fileId: string): Promise<DriveFile>;
  trash(fileId: string): Promise<void>;
  exportText(fileId: string, mimeType: string): Promise<string>;
}

export class DriveError extends Error {
  readonly status: number;
  readonly reason: string;

  constructor(message: string, status: number, reason = "") {
    super(message);
    this.name = "DriveError";
    this.status = status;
    this.reason = reason;
  }
}

export interface TokenProvider {
  /** Returns a valid access token, refreshing it when needed. */
  accessToken(): Promise<string>;
}

const FIELDS = "id,name,mimeType,parents,trashed,modifiedTime,lastModifyingUser";

export class RestDriveClient implements DriveClient {
  private readonly tokens: TokenProvider;

  constructor(tokens: TokenProvider) {
    this.tokens = tokens;
  }

  private async request(
    method: string,
    url: string,
    opts: { json?: unknown; body?: Buffer | string; contentType?: string } = {},
  ): Promise<unknown> {
    const token = await this.tokens.accessToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    let body: Buffer | string | undefined;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = opts.contentType ?? "application/octet-stream";
      body = opts.body;
    }
    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    if (!res.ok) {
      let reason = "";
      try {
        const parsed = JSON.parse(text) as { error?: { errors?: { reason?: string }[] } };
        reason = parsed.error?.errors?.[0]?.reason ?? "";
      } catch {
        // non-JSON error body
      }
      throw new DriveError(
        `${method} ${url.replace(API, "")} -> ${res.status}${reason ? ` (${reason})` : ""}: ${text.slice(0, 300)}`,
        res.status,
        reason,
      );
    }
    return text === "" ? {} : JSON.parse(text);
  }

  async createFolder(name: string, parentId?: string): Promise<DriveFile> {
    const metadata: Record<string, unknown> = { name, mimeType: GOOGLE_FOLDER };
    if (parentId) metadata.parents = [parentId];
    return (await this.request("POST", `${API}/drive/v3/files?fields=${FIELDS}`, {
      json: metadata,
    })) as DriveFile;
  }

  async createEmptyDoc(name: string, parentId: string): Promise<DriveFile> {
    return (await this.request("POST", `${API}/drive/v3/files?fields=${FIELDS}`, {
      json: { name, mimeType: GOOGLE_DOC, parents: [parentId] },
    })) as DriveFile;
  }

  async convertUpload(
    name: string,
    targetMime: string,
    mediaMime: string,
    data: Buffer | string,
    parentId: string,
  ): Promise<DriveFile> {
    const boundary = `gdp${crypto.randomBytes(12).toString("hex")}`;
    const meta = JSON.stringify({ name, mimeType: targetMime, parents: [parentId] });
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mediaMime}\r\n\r\n`,
      ),
      Buffer.isBuffer(data) ? data : Buffer.from(data),
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    return (await this.request(
      "POST",
      `${API}/upload/drive/v3/files?uploadType=multipart&fields=${FIELDS}`,
      { body, contentType: `multipart/related; boundary=${boundary}` },
    )) as DriveFile;
  }

  async updateMedia(fileId: string, mediaMime: string, data: Buffer | string): Promise<void> {
    await this.request("PATCH", `${API}/upload/drive/v3/files/${fileId}?uploadType=media`, {
      body: data,
      contentType: mediaMime,
    });
  }

  async rename(fileId: string, name: string): Promise<void> {
    await this.request("PATCH", `${API}/drive/v3/files/${fileId}`, { json: { name } });
  }

  async get(fileId: string): Promise<DriveFile> {
    return (await this.request(
      "GET",
      `${API}/drive/v3/files/${fileId}?fields=${FIELDS}`,
    )) as DriveFile;
  }

  async trash(fileId: string): Promise<void> {
    await this.request("PATCH", `${API}/drive/v3/files/${fileId}`, { json: { trashed: true } });
  }

  async exportText(fileId: string, mimeType: string): Promise<string> {
    const token = await this.tokens.accessToken();
    const res = await fetch(
      `${API}/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(mimeType)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const text = await res.text();
    if (!res.ok) throw new DriveError(`export ${mimeType} -> ${res.status}`, res.status);
    return text;
  }
}
