// Phase 2 E: file browsing / preview over the remote channel.
//
// Only the workspace and the project transcript directory are reachable. Every
// path the PWA sends is resolved with realpath() and then checked against those
// roots, so `..` traversal and symlinks pointing outside are both rejected at
// the bridge — the PWA's path is never trusted. Secret file names / credential
// directories are refused as well (same list as files.mjs).
//
// Sizes: text replies are capped at READ_MAX bytes per request and re-checked
// against the frame budget after JSON escaping; blobs are streamed in chunks
// because the relay closes a socket above 256 KB per frame and the bridge caps
// plaintext at 180 KB.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CFG, PATHS } from "./config.mjs";
import { mimeOf, fileKind } from "./http.mjs";

export const READ_MAX = 48_000;          // 一次 read 的原始字节上限（转义后仍在 120 KB 以内）
export const BLOB_TOTAL_MAX = 5 << 20;   // 单个文件走 blob 的上限 5 MB
export const BLOB_CHUNK = 90_000;        // base64 后约 120 KB，低于 180 KB 明文上限
export const REPLY_MAX = 150_000;        // 单条 a2c 明文的实际预算

const SECRET_NAMES = new Set([
  "ccapp-providers.json", "ccapp-config.json", "ccapp-seed.json",
  "keystore.json", "debug.keystore", "id_ed25519", "id_rsa", "id_ecdsa",
]);
const SECRET_RE = /(^|\/)(\.ssh|\.gnupg|\.aws|\.config\/gcloud)(\/|$)/;

/** 允许访问的根：工作区 + 项目记录目录（都存在时才列） */
export function allowedRoots() {
  const out = [];
  for (const r of [CFG.workspace, PATHS.projects]) {
    if (!r) continue;
    try { out.push(fs.realpathSync(r)); } catch {}
  }
  return [...new Set(out)];
}

/** 给界面看的根列表（工作区 / 项目记录） */
export function rootList(roots = allowedRoots()) {
  let ws = null;
  try { ws = fs.realpathSync(CFG.workspace); } catch {}
  return roots.map((p) => ({ name: p === ws ? "工作区" : "项目记录", path: p }));
}

export function isInside(real, root) {
  if (!real || !root) return false;
  const rel = path.relative(root, real);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

const insideAny = (real, roots) => roots.some((r) => isInside(real, r));

/** 解析并校验一个路径。null / 空串 = 默认根（工作区）。错误只回 not found / forbidden，
 *  不把真实路径、也不把「是否存在」以外的信息带出去。 */
export function resolveRemotePath(raw, { roots = allowedRoots(), base } = {}) {
  if (!roots.length) return { error: "no workspace" };
  let full;
  if (raw == null || raw === "") full = base || roots[0];
  else if (typeof raw !== "string") return { error: "bad path" };
  else {
    full = raw.trim();
    if (!full) full = base || roots[0];
    if (full.startsWith("file://")) {
      try { full = fileURLToPath(full); } catch { return { error: "bad path" }; }
    }
    if (!path.isAbsolute(full)) full = path.join(roots[0], full);
  }
  // 先做一次不碰磁盘的词法检查：范围外的路径一律 forbidden，不再区分存不存在
  if (!insideAny(path.resolve(full), roots)) return { error: "forbidden" };
  let real;
  try { real = fs.realpathSync(full); }
  catch (e) { return { error: /EACCES|EPERM/.test(String(e.code)) ? "forbidden" : "not found" }; }
  if (!insideAny(real, roots)) return { error: "forbidden" };
  const name = path.basename(real).toLowerCase();
  if (SECRET_NAMES.has(name) || SECRET_RE.test(real)) return { error: "forbidden" };
  return { path: real, roots };
}

/** 上级目录；出了允许范围就是 null（界面据此禁用「上一级」） */
export function parentOf(real, roots = allowedRoots()) {
  const up = path.dirname(real);
  if (up === real || !insideAny(up, roots)) return null;
  return up;
}

/** 列目录：隐藏项不列；软链先解到真实路径，指到允许范围外的整条跳过 */
export function listDir(real, { roots = allowedRoots(), max = 500 } = {}) {
  const items = fs.readdirSync(real, { withFileTypes: true });
  const entries = [];
  let truncated = false;
  for (const it of items) {
    if (it.name.startsWith(".")) continue;
    if (SECRET_NAMES.has(it.name.toLowerCase())) continue;
    const full = path.join(real, it.name);
    let dir = it.isDirectory(), size = 0, mtime = 0;
    try {
      const target = it.isSymbolicLink() ? fs.realpathSync(full) : full;   // 悬空链抛错 → 不列
      if (it.isSymbolicLink() && (!insideAny(target, roots) || SECRET_RE.test(target))) continue;
      const st = fs.statSync(target);
      if (!dir && st.isDirectory()) dir = true;
      size = dir ? 0 : st.size;
      mtime = st.mtimeMs;
    } catch { continue; }
    entries.push({ name: it.name, dir, size, mtime, kind: fileKind(it.name, dir) });
    if (entries.length >= max) { truncated = true; break; }
  }
  entries.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    if (a.dir) return a.name.localeCompare(b.name);
    return b.mtime - a.mtime || a.name.localeCompare(b.name);
  });
  return { entries, truncated };
}

/** 末尾被切开的 UTF-8 多字节字符退掉，别让翻页处冒出替换符 */
function cutPartialUtf8(buf) {
  let n = 0;
  for (let i = buf.length - 1; i >= 0 && n < 3; i--, n++) {
    const b = buf[i];
    if ((b & 0x80) === 0) return buf.length;              // ASCII：边界正好
    if ((b & 0xC0) === 0xC0) {                            // 首字节：看后面够不够
      const need = b >= 0xF0 ? 4 : b >= 0xE0 ? 3 : 2;
      return buf.length - i < need ? i : buf.length;
    }
  }
  return buf.length;
}

/** 读一段文本。二进制（前 8 KB 有 NUL）只回 binary + mime，正文不硬塞进 JSON */
export function readTextFile(file, { offset = 0, limit } = {}) {
  const st = fs.statSync(file);
  if (!st.isFile()) return { error: "not a regular file" };
  const size = st.size;
  const off = Math.max(0, Math.min(size, Math.floor(Number(offset) || 0)));
  const want = Math.max(1, Math.min(READ_MAX, Math.floor(Number(limit) || READ_MAX)));
  const n = Math.min(want, size - off);
  const fd = fs.openSync(file, "r");
  let buf;
  try {
    buf = Buffer.alloc(n);
    if (n) fs.readSync(fd, buf, 0, n, off);
  } finally { fs.closeSync(fd); }
  const head = buf.subarray(0, Math.min(8192, n));
  if (head.includes(0)) return { binary: true, size, offset: off, mime: mimeOf(file), kind: fileKind(file, false) };
  const cut = cutPartialUtf8(buf);
  const data = buf.subarray(0, cut).toString("utf8");
  return { data, size, offset: off, next: off + cut, eof: off + cut >= size, mime: mimeOf(file) };
}

/** 一段二进制（base64）。offset 是原始字节偏移，next=null 表示读完了 */
export function blobChunk(file, offset = 0) {
  const st = fs.statSync(file);
  if (!st.isFile()) return { error: "not a regular file" };
  if (st.size > BLOB_TOTAL_MAX) return { error: "too large", size: st.size, max: BLOB_TOTAL_MAX };
  const off = Math.max(0, Math.min(st.size, Math.floor(Number(offset) || 0)));
  const n = Math.min(BLOB_CHUNK, st.size - off);
  const fd = fs.openSync(file, "r");
  let buf;
  try {
    buf = Buffer.alloc(n);
    if (n) fs.readSync(fd, buf, 0, n, off);
  } finally { fs.closeSync(fd); }
  return {
    data: buf.toString("base64"), size: st.size, offset: off,
    next: off + n < st.size ? off + n : null, mime: mimeOf(file),
  };
}

/** JSON 转义会把正文撑大（换行、引号、emoji）：超预算就截断，别让整条回复被 sendTo 丢掉 */
export function fitTextReply(reply, max = REPLY_MAX) {
  const bytes = Buffer.byteLength(JSON.stringify(reply), "utf8");
  if (bytes <= max) return reply;
  const data = String(reply.data || "");
  const keep = Math.max(1000, Math.floor((data.length * max) / bytes * 0.8));
  let cut = data.slice(0, keep);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return { ...reply, data: cut + "\n…（已截断）", eof: false, truncated: true };
}
