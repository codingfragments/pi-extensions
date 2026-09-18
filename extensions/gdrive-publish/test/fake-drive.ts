/**
 * In-memory DriveClient used by the offline test suite.
 *
 * It records every call so tests can assert the *sequence* (two-phase order,
 * update-in-place instead of recreate, trash instead of delete), which is
 * where the real risk lives.
 */

import type { DriveClient, DriveFile } from "../core/drive.ts";
import { GOOGLE_DOC, GOOGLE_FOLDER } from "../core/types.ts";

export interface FakeFile extends DriveFile {
  content?: string;
  mediaMime?: string;
}

export class FakeDrive implements DriveClient {
  readonly files = new Map<string, FakeFile>();
  readonly calls: string[] = [];
  private counter = 0;
  /** Set to make `get` report a Drive-side modification. */
  modifiedTimes = new Map<string, string>();
  /** Ids that should behave as inaccessible (simulates 404/trashed). */
  missing = new Set<string>();

  private nextId(prefix: string): string {
    this.counter++;
    return `${prefix}${String(this.counter).padStart(4, "0")}`;
  }

  async createFolder(name: string, parentId?: string): Promise<DriveFile> {
    this.calls.push(`createFolder(${name},${parentId ?? "root"})`);
    const file: FakeFile = {
      id: this.nextId("fld"),
      name,
      mimeType: GOOGLE_FOLDER,
      ...(parentId ? { parents: [parentId] } : {}),
    };
    this.files.set(file.id, file);
    return file;
  }

  async createEmptyDoc(name: string, parentId: string): Promise<DriveFile> {
    this.calls.push(`createEmptyDoc(${name},${parentId})`);
    const file: FakeFile = {
      id: this.nextId("doc"),
      name,
      mimeType: GOOGLE_DOC,
      parents: [parentId],
      content: "",
    };
    this.files.set(file.id, file);
    return file;
  }

  async convertUpload(
    name: string,
    targetMime: string,
    mediaMime: string,
    data: Buffer | string,
    parentId: string,
  ): Promise<DriveFile> {
    this.calls.push(`convertUpload(${name},${targetMime},${mediaMime},${parentId})`);
    const file: FakeFile = {
      id: this.nextId("sht"),
      name,
      mimeType: targetMime,
      parents: [parentId],
      content: Buffer.isBuffer(data) ? data.toString("base64").slice(0, 32) : data,
      mediaMime,
    };
    this.files.set(file.id, file);
    return file;
  }

  async updateMedia(fileId: string, mediaMime: string, data: Buffer | string): Promise<void> {
    this.calls.push(`updateMedia(${fileId},${mediaMime})`);
    const file = this.files.get(fileId);
    if (!file) throw new Error(`fake drive: no such file ${fileId}`);
    file.content = Buffer.isBuffer(data) ? data.toString("base64").slice(0, 32) : data;
    file.mediaMime = mediaMime;
  }

  async rename(fileId: string, name: string): Promise<void> {
    this.calls.push(`rename(${fileId},${name})`);
    const file = this.files.get(fileId);
    if (file) file.name = name;
  }

  async get(fileId: string): Promise<DriveFile> {
    this.calls.push(`get(${fileId})`);
    if (this.missing.has(fileId)) {
      const err = new Error("not found") as Error & { status: number };
      err.status = 404;
      throw err;
    }
    const file = this.files.get(fileId);
    if (!file) throw new Error(`fake drive: no such file ${fileId}`);
    const modified = this.modifiedTimes.get(fileId);
    return modified ? { ...file, modifiedTime: modified } : file;
  }

  async trash(fileId: string): Promise<void> {
    this.calls.push(`trash(${fileId})`);
    const file = this.files.get(fileId);
    if (file) file.trashed = true;
  }

  async exportText(fileId: string): Promise<string> {
    this.calls.push(`exportText(${fileId})`);
    return this.files.get(fileId)?.content ?? "";
  }

  /** Convenience for assertions. */
  contentOf(fileId: string): string {
    return this.files.get(fileId)?.content ?? "";
  }
}
