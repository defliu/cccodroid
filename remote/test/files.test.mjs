// Phase 2 E：远程文件浏览的路径政策、读取上限与分片。
// 网关模块导入前先设好测试环境（config.mjs 拒绝在测试里碰真 home）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ccapp-rf-"));
process.env.CCAPP_TEST = "1";
process.env.CCAPP_HOME = path.join(TMP, "home");
process.env.CCAPP_WORKSPACE = path.join(TMP, "ws");
fs.mkdirSync(process.env.CCAPP_HOME, { recursive: true });
fs.mkdirSync(process.env.CCAPP_WORKSPACE, { recursive: true });

const RF = await import("../../gateway/gw/remote-files.mjs");
const {
  allowedRoots, rootList, resolveRemotePath, parentOf, listDir,
  readTextFile, blobChunk, fitTextReply, READ_MAX, BLOB_CHUNK, BLOB_TOTAL_MAX,
} = RF;

const WS = fs.realpathSync(process.env.CCAPP_WORKSPACE);
const PROJ = path.join(process.env.CCAPP_HOME, ".claude", "projects");
fs.mkdirSync(PROJ, { recursive: true });
const OUT = path.join(TMP, "outside");
fs.mkdirSync(OUT, { recursive: true });

fs.writeFileSync(path.join(OUT, "secret.txt"), "nope");
fs.writeFileSync(path.join(WS, "a.txt"), "hello\nworld\n");
fs.writeFileSync(path.join(WS, "id_rsa"), "PRIVATE");
fs.writeFileSync(path.join(WS, ".hidden"), "h");
fs.writeFileSync(path.join(WS, "bin.dat"), Buffer.from([1, 2, 0, 3, 4]));
fs.writeFileSync(path.join(WS, "multi.txt"), "a中b");
fs.writeFileSync(path.join(WS, "big.bin"), Buffer.alloc(200_000, 7));
fs.writeFileSync(path.join(WS, "long.txt"), "l".repeat(100_000));
fs.writeFileSync(path.join(WS, "huge.bin"), Buffer.alloc(BLOB_TOTAL_MAX + 1, 5));
fs.mkdirSync(path.join(WS, "sub"));
fs.writeFileSync(path.join(WS, "sub", "c.md"), "# c\n");
fs.writeFileSync(path.join(PROJ, "s.jsonl"), "{\"type\":\"user\"}\n");

// Windows 的目录 junction 不需要管理员权限；文件软链可能建不起来，建不起来就跳过对应用例
let linkIn = false, linkOut = false;
try { fs.symlinkSync(path.join(WS, "sub"), path.join(WS, "link-in"), "junction"); linkIn = true; } catch {}
try { fs.symlinkSync(OUT, path.join(WS, "link-out"), "junction"); linkOut = true; } catch {}

const roots = allowedRoots();

test("files: roots are workspace + project records only", () => {
  assert.equal(roots.length, 2);
  assert.ok(roots.includes(WS));
  assert.ok(roots.includes(fs.realpathSync(PROJ)));
  const names = rootList(roots).map((r) => r.name).sort();
  assert.deepEqual(names, ["工作区", "项目记录"].sort());
});

test("files: relative and absolute paths inside roots resolve", () => {
  assert.equal(resolveRemotePath("a.txt", { roots }).path, path.join(WS, "a.txt"));
  assert.equal(resolveRemotePath(path.join(WS, "sub", "c.md"), { roots }).path, path.join(WS, "sub", "c.md"));
  assert.equal(resolveRemotePath(path.join(PROJ, "s.jsonl"), { roots }).path, path.join(PROJ, "s.jsonl"));
  assert.equal(resolveRemotePath(null, { roots }).path, WS);
  assert.equal(resolveRemotePath("", { roots }).path, WS);
});

test("files: traversal, outside paths and secrets are refused", () => {
  assert.equal(resolveRemotePath("../outside/secret.txt", { roots }).error, "forbidden");
  assert.equal(resolveRemotePath("../outside/does-not-exist", { roots }).error, "forbidden");   // 不区分存不存在
  assert.equal(resolveRemotePath(path.join(OUT, "secret.txt"), { roots }).error, "forbidden");
  assert.equal(resolveRemotePath("id_rsa", { roots }).error, "forbidden");
  assert.equal(resolveRemotePath("nope.txt", { roots }).error, "not found");
  assert.equal(resolveRemotePath(42, { roots }).error, "bad path");
  assert.equal(resolveRemotePath("a.txt", { roots }).path, path.join(WS, "a.txt"));   // 正常路径不受影响
});

test("files: symlinks are resolved; escaping ones are refused", { skip: !linkOut && !linkIn }, () => {
  if (linkIn) assert.equal(resolveRemotePath("link-in", { roots }).path, path.join(WS, "sub"));
  if (linkOut) assert.equal(resolveRemotePath("link-out", { roots }).error, "forbidden");
});

test("files: listing hides dotfiles, secrets and escaping symlinks", () => {
  const { entries, truncated } = listDir(WS, { roots });
  const names = entries.map((e) => e.name);
  assert.ok(names.includes("a.txt"));
  assert.ok(names.includes("sub"));
  assert.ok(!names.includes(".hidden"));
  assert.ok(!names.includes("id_rsa"));
  if (linkOut) assert.ok(!names.includes("link-out"));
  assert.equal(truncated, false);
  assert.equal(entries[0].dir, true);            // 目录在前
  assert.equal(entries.find((e) => e.name === "sub").dir, true);
  assert.equal(entries.find((e) => e.name === "a.txt").dir, false);
  assert.equal(entries.find((e) => e.name === "a.txt").kind, "text");
  assert.equal(entries.find((e) => e.name === "big.bin").size, 200_000);
});

test("files: parent stops at an allowed root", () => {
  assert.equal(parentOf(path.join(WS, "sub"), roots), WS);
  assert.equal(parentOf(WS, roots), null);
  assert.equal(parentOf(path.join(PROJ, "s.jsonl"), roots), fs.realpathSync(PROJ));
});

test("files: text read is complete, offset-aware and eof-aware", () => {
  const full = readTextFile(path.join(WS, "a.txt"));
  assert.equal(full.data, "hello\nworld\n");
  assert.equal(full.eof, true);
  assert.equal(full.next, full.size);
  const part = readTextFile(path.join(WS, "a.txt"), { offset: 6, limit: 5 });
  assert.equal(part.data, "world");
  assert.equal(part.eof, false);
  assert.equal(part.next, 11);
});

test("files: a multibyte character cut by the chunk boundary is dropped, not mangled", () => {
  const r1 = readTextFile(path.join(WS, "multi.txt"), { limit: 2 });   // "a" + 中 的前 2 字节
  assert.equal(r1.data, "a");
  assert.equal(r1.next, 1);
  assert.equal(r1.eof, false);
  const r2 = readTextFile(path.join(WS, "multi.txt"), { offset: 1, limit: 4 });
  assert.equal(r2.data, "中b");
  assert.equal(r2.eof, true);
});

test("files: binary files report binary instead of raw bytes", () => {
  const r = readTextFile(path.join(WS, "bin.dat"));
  assert.equal(r.binary, true);
  assert.equal(r.data, undefined);
  assert.equal(r.size, 5);
});

test("files: read caps at READ_MAX bytes", () => {
  const r = readTextFile(path.join(WS, "long.txt"), { limit: READ_MAX * 10 });
  assert.equal(r.data.length, READ_MAX);
  assert.equal(r.eof, false);
  assert.equal(r.next, READ_MAX);
  const last = readTextFile(path.join(WS, "long.txt"), { offset: READ_MAX });
  assert.equal(last.data.length, READ_MAX);
  assert.equal(last.eof, false);
  assert.equal(last.next, READ_MAX * 2);
  const end = readTextFile(path.join(WS, "long.txt"), { offset: READ_MAX * 2 });
  assert.equal(end.data.length, 100_000 - READ_MAX * 2);
  assert.equal(end.eof, true);
});

test("files: blob chunks cover the file and stop at the end", () => {
  const first = blobChunk(path.join(WS, "big.bin"), 0);
  assert.equal(first.size, 200_000);
  assert.equal(first.offset, 0);
  assert.equal(first.next, BLOB_CHUNK);
  assert.equal(Buffer.from(first.data, "base64").length, BLOB_CHUNK);
  const second = blobChunk(path.join(WS, "big.bin"), first.next);
  assert.equal(second.next, BLOB_CHUNK * 2);
  assert.equal(Buffer.from(second.data, "base64").length, BLOB_CHUNK);
  const third = blobChunk(path.join(WS, "big.bin"), second.next);
  assert.equal(third.next, null);
  assert.equal(Buffer.from(third.data, "base64").length, 200_000 - BLOB_CHUNK * 2);
  const tooBig = blobChunk(path.join(WS, "huge.bin"), 0);
  assert.equal(tooBig.error, "too large");
  assert.equal(tooBig.size, BLOB_TOTAL_MAX + 1);
  assert.equal(blobChunk(path.join(WS, "a.txt"), 0).mime.startsWith("text/plain"), true);
});

test("files: text replies are trimmed under the frame budget after escaping", () => {
  const reply = { type: "read", path: "/x", data: "x\n\"\\".repeat(60_000), size: 300_000, eof: true };
  const fitted = fitTextReply(reply);
  assert.equal(fitted.truncated, true);
  assert.equal(fitted.eof, false);
  assert.ok(Buffer.byteLength(JSON.stringify(fitted), "utf8") <= RF.REPLY_MAX);
  assert.equal(fitTextReply({ data: "small" }).truncated, undefined);
});
