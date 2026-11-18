// cccodroid remote — shared protocol helpers (runs in Node 20+ and modern browsers).
//
// Pairing
//   The agent (cccrodroid gateway) opens a room on the relay with sha256(pairCode).
//   The remote client proves knowledge of the code with that hash and a HMAC over
//   its ephemeral public key; the relay only sees hashes and public keys, never the
//   code or the data key.
//
// Data
//   Ephemeral P-256 ECDH -> HKDF(roomId) -> AES-256-GCM. Relay forwards opaque
//   ciphertext envelopes; AAD binds roomId and direction.

const TE = new TextEncoder();
const TD = new TextDecoder();
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Crockford-ish, no 0/1/I/O
export const CODE_LEN = 26;

export const b64url = (bytes) => {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const unb64url = (s) => {
  const norm = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const pad = norm.length % 4 ? "=".repeat(4 - (norm.length % 4)) : "";
  return Uint8Array.from(atob(norm + pad), (c) => c.charCodeAt(0));
};

export const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function randomCode(len = CODE_LEN) {
  const out = [];
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  for (let i = 0; i < len; i++) out.push(ALPHABET[buf[i] & 31]);
  return out.join("");
}

export function normalizeCode(code) {
  return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", TE.encode(text));
  return hex(new Uint8Array(d));
}

async function hkdf(ikm, salt, info, length = 32) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: TE.encode(salt), info: TE.encode(info) },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

/** HMAC key derived from the pairing code; the relay never sees the code. */
export const pairKeyFromCode = (code) =>
  hkdf(TE.encode(normalizeCode(code)), "ccc-remote-v1", "pair-key", 32);

export async function hmacHex(keyBytes, message) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, TE.encode(message));
  return hex(new Uint8Array(sig));
}

/** Ephemeral P-256 keypair; returns { privateKey, publicKey, pubRaw } */
export async function generateEcdh() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, pubRaw };
}

export async function deriveShared(privateKey, peerPubRaw) {
  const peerKey = await crypto.subtle.importKey(
    "raw",
    peerPubRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: peerKey }, privateKey, 256);
  return new Uint8Array(bits);
}

export async function dataKeyFromShared(shared, roomId) {
  const raw = await hkdf(shared, String(roomId), "data-key", 32);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptText(aesKey, plaintext, aad) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: TE.encode(aad) },
    aesKey,
    TE.encode(plaintext)
  );
  return { iv: b64url(iv), ct: b64url(new Uint8Array(ct)) };
}

export async function decryptText(aesKey, ivB64, ctB64, aad) {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64url(ivB64), additionalData: TE.encode(aad) },
    aesKey,
    unb64url(ctB64)
  );
  return TD.decode(pt);
}

/** The HMAC both sides exchange to authenticate the ephemeral key. */
export const keyProofMessage = (role, pubB64) => `${role}:${pubB64}`;
