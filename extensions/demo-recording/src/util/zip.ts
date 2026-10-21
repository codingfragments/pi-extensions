/**
 * A minimal ZIP writer (stored entries, no compression): videos and images
 * don't compress, so storing is as small and much faster. No dependencies,
 * no system `zip`. Entries are streamed (CRC pass + copy pass), so large
 * videos never sit in memory. Limit: < 4 GiB per file and per archive (no
 * ZIP64) — a render variant is far below that.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export interface ZipEntry {
  /** Path inside the archive (forward slashes). */
  name: string;
  file: string;
}

const LIMIT = 0xffffffff;

export async function crcOf(file: string): Promise<number> {
  let crc = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 }))
    crc = zlib.crc32(chunk as Buffer, crc);
  return crc >>> 0;
}

/** DOS date/time of a Date (zip's timestamp format). */
function dosTime(d: Date): { time: number; date: number } {
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31),
    date:
      (((d.getFullYear() - 1980) & 127) << 9) |
      (((d.getMonth() + 1) & 15) << 5) |
      (d.getDate() & 31),
  };
}

/** Write `entries` into `out` (via a temp file, renamed when complete). Returns the archive size. */
export async function writeZip(out: string, entries: ZipEntry[]): Promise<number> {
  const tmp = `${out}.part`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const fd = fs.openSync(tmp, "w");
  let offset = 0;
  const central: Buffer[] = [];
  const write = (b: Buffer) => {
    fs.writeSync(fd, b);
    offset += b.length;
  };
  try {
    for (const e of entries) {
      const st = fs.statSync(e.file);
      if (st.size >= LIMIT)
        throw new Error(`${e.name} is larger than 4 GiB — too big for this zip writer`);
      const crc = await crcOf(e.file);
      const name = Buffer.from(e.name.replace(/\\/g, "/"), "utf8");
      const { time, date } = dosTime(st.mtime);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4); // version needed
      local.writeUInt16LE(0x0800, 6); // UTF-8 names
      local.writeUInt16LE(0, 8); // stored
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(st.size, 18);
      local.writeUInt32LE(st.size, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      const at = offset;
      write(local);
      write(name);
      for await (const chunk of fs.createReadStream(e.file, { highWaterMark: 1 << 20 }))
        write(chunk as Buffer);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4); // made by
      c.writeUInt16LE(20, 6); // needed
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(0, 10);
      c.writeUInt16LE(time, 12);
      c.writeUInt16LE(date, 14);
      c.writeUInt32LE(crc, 16);
      c.writeUInt32LE(st.size, 20);
      c.writeUInt32LE(st.size, 24);
      c.writeUInt16LE(name.length, 28);
      c.writeUInt16LE(0, 30); // extra
      c.writeUInt16LE(0, 32); // comment
      c.writeUInt16LE(0, 34); // disk
      c.writeUInt16LE(0, 36); // internal attrs
      c.writeUInt32LE(0, 38); // external attrs
      c.writeUInt32LE(at, 42);
      central.push(c, name);
      if (offset >= LIMIT) throw new Error("the archive would be larger than 4 GiB");
    }
    const cdStart = offset;
    for (const b of central) write(b);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(offset - cdStart, 12);
    end.writeUInt32LE(cdStart, 16);
    write(end);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, out);
  return offset;
}

export interface ZipIndexEntry {
  name: string;
  size: number;
  crc: number;
  /** Where the local header starts. */
  offset: number;
}

/** The entries of a zip this writer made (stored entries, no ZIP64, no archive comment), read from its central directory. */
export function readZipIndex(file: string): ZipIndexEntry[] {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 22) throw new Error("not a zip file (too short)");
    const end = Buffer.alloc(22);
    fs.readSync(fd, end, 0, 22, size - 22);
    if (end.readUInt32LE(0) !== 0x06054b50) throw new Error("not a zip file (no end record)");
    const count = end.readUInt16LE(10);
    const cdSize = end.readUInt32LE(12);
    const cdStart = end.readUInt32LE(16);
    if (cdStart + cdSize > size) throw new Error("the zip's directory is cut off");
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdStart);
    const out: ZipIndexEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error("the zip's directory is damaged");
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      out.push({
        name: cd.toString("utf8", p + 46, p + 46 + nameLen),
        crc: cd.readUInt32LE(p + 16),
        size: cd.readUInt32LE(p + 24),
        offset: cd.readUInt32LE(p + 42),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/** The CRC of one entry's stored bytes, read back from the zip (what a restore would get). */
export async function crcOfEntry(file: string, e: ZipIndexEntry): Promise<number> {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(30);
    fs.readSync(fd, head, 0, 30, e.offset);
    if (head.readUInt32LE(0) !== 0x04034b50)
      throw new Error(`${e.name}: the local header is damaged`);
    const start = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    if (e.size === 0) return 0; // an empty file has no bytes to read (and a stream cannot end before it starts)
    let crc = 0;
    for await (const chunk of fs.createReadStream(file, {
      start,
      end: start + e.size - 1,
      highWaterMark: 1 << 20,
    }))
      crc = zlib.crc32(chunk as Buffer, crc);
    return crc >>> 0;
  } finally {
    fs.closeSync(fd);
  }
}

/** A zip's size limit for this writer: archives and files below 4 GiB (no ZIP64). */
export const ZIP_LIMIT = LIMIT;
