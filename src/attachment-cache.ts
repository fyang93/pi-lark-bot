import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, open, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { basename, join } from "node:path";
import { privateDir } from "./storage.ts";

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_CACHE_BYTES = 1024 * 1024 * 1024;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface CachedAttachment { path: string; name: string; size: number }

type Download = () => Promise<AsyncIterable<Uint8Array | string>>;

/** Persistent, content-addressed cache for immutable Lark message resources. */
export class AttachmentCache {
  private readonly pending = new Map<string, Promise<CachedAttachment>>();
  constructor(private root: string, private maxFileBytes = MAX_ATTACHMENT_BYTES,
    private maxCacheBytes = MAX_CACHE_BYTES, private retentionMs = RETENTION_MS) {}

  get(key: string, originalName: string, download: Download): Promise<CachedAttachment> {
    const digest = createHash("sha256").update(key).digest("hex");
    const existing = this.pending.get(digest);
    if (existing) return existing;
    const task = this.load(digest, safeFilename(originalName), download);
    this.pending.set(digest, task);
    void task.then(() => this.pending.delete(digest), () => this.pending.delete(digest));
    return task;
  }

  private async load(digest: string, name: string, download: Download): Promise<CachedAttachment> {
    await privateDir(this.root);
    const dir = join(this.root, digest);
    const path = join(dir, name);
    try {
      const dirInfo = await lstat(dir);
      if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) throw new Error("Refusing unsafe attachment cache entry");
      try {
        const info = await lstat(path);
        if (info.isFile() && !info.isSymbolicLink() && info.size <= this.maxFileBytes) {
          await utimes(path, new Date(), new Date());
          return { path, name, size: info.size };
        }
        await rm(dir, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await rm(dir, { recursive: true, force: true });
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

    await privateDir(dir);
    const temp = join(dir, `.${randomUUID()}.tmp`);
    const handle = await open(temp, "wx", 0o600);
    let size = 0;
    try {
      const source = await download();
      for await (const value of source) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        size += chunk.byteLength;
        if (size > this.maxFileBytes) throw new Error(`Referenced file exceeds ${this.maxFileBytes} bytes`);
        await handle.writeFile(chunk);
      }
      await handle.sync();
    } catch (error) {
      await handle.close();
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    await handle.close();
    try {
      await rename(temp, path);
      await chmod(path, 0o600);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    await this.prune(path);
    return { path, name, size };
  }

  private async prune(keep: string): Promise<void> {
    const files: Array<{ path: string; dir: string; size: number; mtimeMs: number }> = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const dir = join(this.root, entry.name);
      for (const child of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (!child.isFile() || child.isSymbolicLink()) continue;
        const path = join(dir, child.name);
        const info = await stat(path);
        files.push({ path, dir, size: info.size, mtimeMs: info.mtimeMs });
      }
    }
    const cutoff = Date.now() - this.retentionMs;
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (file.path === keep || file.mtimeMs >= cutoff && total <= this.maxCacheBytes) continue;
      await rm(file.dir, { recursive: true, force: true });
      total -= file.size;
    }
  }
}

export function safeFilename(value: string): string {
  const clean = basename(value.replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 160);
  return clean && clean !== "." && clean !== ".." ? clean : "attachment.bin";
}
