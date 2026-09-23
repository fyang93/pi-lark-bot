import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentCache, safeFilename } from "../src/attachment-cache.ts";

async function* bytes(value: string) { yield Buffer.from(value); }

test("attachment cache sanitizes names, coalesces downloads, persists files privately, and enforces limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "lark-attachments-"));
  try {
    const cache = new AttachmentCache(root, 8, 32, 1000);
    let downloads = 0;
    const download = async () => { downloads++; return bytes("content"); };
    const [first, second] = await Promise.all([
      cache.get("same-resource", "../../bad\nname.txt", download),
      cache.get("same-resource", "ignored.txt", download),
    ]);
    assert.equal(downloads, 1);
    assert.equal(first.path, second.path);
    assert.equal(first.name, "bad name.txt");
    assert.equal((await stat(first.path)).mode & 0o777, 0o600);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await readdir(root)).length, 1);

    await assert.rejects(cache.get("too-large", "large.bin", async () => bytes("123456789")), /exceeds 8 bytes/);
    assert.equal((await readdir(root)).length, 1, "failed downloads leave no partial cache entry");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("safeFilename rejects path traversal and control-only names", () => {
  assert.equal(safeFilename("../folder/report.pdf"), "report.pdf");
  assert.equal(safeFilename(".."), "attachment.bin");
  assert.equal(safeFilename("\u0000"), "attachment.bin");
});
