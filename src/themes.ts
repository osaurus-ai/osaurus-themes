import {
  buildDeleteMessage,
  buildWriteMessage,
  generateNonce,
  isTimestampValid,
  verifySignature,
} from "./auth.ts";
import {
  addOwnerIndex,
  consumeNonce,
  countOwnerThemes,
  deleteThemeMeta,
  getThemeMeta,
  isRedisConfigured,
  issueNonce,
  listOwnerThemes,
  removeOwnerIndex,
  saveThemeMeta,
} from "./redis.ts";
import { getStorage, isStorageConfigured } from "./storage.ts";
import { jsonResponse, readBodyBytes, THEME_CACHE_CONTROL, withTimeout } from "./http.ts";
import type {
  ChallengeRequest,
  ChallengeResponse,
  ListOwnerThemesResponse,
  SaveThemeResponse,
  ThemeMetaResponse,
} from "./types.ts";

export const MAX_THEME_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_THEMES_PER_OWNER = Number(
  Deno.env.get("MAX_THEMES_PER_OWNER") ?? "1000",
);
export const REQUEST_TIMEOUT_MS = Number(
  Deno.env.get("REQUEST_TIMEOUT_MS") ?? "30000",
);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

const BASE_URL = (Deno.env.get("BASE_URL") ?? "").replace(/\/+$/, "");
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

if (!BASE_URL) {
  console.warn(
    "[themes] BASE_URL is not set. The install URL will be derived from the " +
      "incoming Host header, which an attacker can spoof if the app is " +
      "reachable outside Fly's edge. Set BASE_URL to your public origin.",
  );
}

function isValidAddress(s: string): boolean {
  return ADDRESS_RE.test(s);
}

function isValidHash(s: string): boolean {
  return HASH_RE.test(s);
}

function hostOnly(host: string): string {
  const colon = host.lastIndexOf(":");
  if (colon > 0 && !host.startsWith("[")) return host.slice(0, colon);
  return host;
}

function originFor(req: Request): string {
  if (BASE_URL) return BASE_URL;
  const url = new URL(req.url);
  const host = req.headers.get("host") ?? url.host;
  const proto = LOCAL_HOSTS.has(hostOnly(host)) ? "http" : "https";
  return `${proto}://${host}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Cheap structural check: does the byte payload look like a JSON object?
 * Avoids a 5 MB allocation from a throwaway JSON.parse just to assert this.
 */
function looksLikeJsonObject(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.byteLength; i++) {
    const c = bytes[i];
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
    return c === 0x7b; // '{'
  }
  return false;
}

interface SignedHeaders {
  address: string;
  nonce: string;
  timestamp: number;
  signature: string;
}

function extractSignedHeaders(req: Request): SignedHeaders | { error: string } {
  const address = req.headers.get("x-agent-address")?.toLowerCase();
  const nonce = req.headers.get("x-nonce");
  const tsRaw = req.headers.get("x-timestamp");
  const signature = req.headers.get("x-signature");
  if (!address || !nonce || !tsRaw || !signature) {
    return { error: "missing_auth_headers" };
  }
  if (!isValidAddress(address)) return { error: "invalid_address" };
  const timestamp = Number(tsRaw);
  if (!Number.isFinite(timestamp)) return { error: "invalid_timestamp" };
  if (!isTimestampValid(timestamp)) return { error: "timestamp_out_of_window" };
  return { address, nonce, timestamp, signature };
}

/**
 * POST /auth/challenge
 */
export async function handleChallenge(req: Request, reqId: string): Promise<Response> {
  let body: ChallengeRequest;
  try {
    body = await req.json() as ChallengeRequest;
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  const address = body?.address?.toLowerCase?.();
  if (!address || !isValidAddress(address)) {
    return jsonResponse(400, { error: "invalid_address" });
  }
  if (!isRedisConfigured()) {
    console.error(`[challenge] [${reqId}] REDIS_URL not configured`);
    return jsonResponse(503, { error: "redis_not_configured" });
  }
  const nonce = generateNonce();
  try {
    await issueNonce(address, nonce);
  } catch (err) {
    console.error(`[challenge] [${reqId}] issueNonce failed:`, err);
    return jsonResponse(503, { error: "storage_unavailable" });
  }
  const res: ChallengeResponse = { nonce, expires_in: 60 };
  return jsonResponse(200, res as unknown as Record<string, unknown>);
}

/**
 * POST /themes
 */
export async function handleSaveTheme(req: Request, reqId: string): Promise<Response> {
  return await withTimeout(
    REQUEST_TIMEOUT_MS,
    (signal) => saveThemeImpl(req, reqId, signal),
    () => {
      console.warn(`[save] [${reqId}] request timed out`);
      return jsonResponse(408, { error: "request_timeout" });
    },
  );
}

async function saveThemeImpl(
  req: Request,
  reqId: string,
  signal: AbortSignal,
): Promise<Response> {
  const signed = extractSignedHeaders(req);
  if ("error" in signed) return jsonResponse(401, signed);

  let bytes: Uint8Array | null;
  try {
    bytes = await readBodyBytes(req, MAX_THEME_BYTES, signal);
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return jsonResponse(408, { error: "request_timeout" });
    }
    throw err;
  }
  if (bytes === null) return jsonResponse(413, { error: "body_too_large" });
  if (bytes.byteLength === 0) return jsonResponse(400, { error: "empty_body" });

  if (!looksLikeJsonObject(bytes)) {
    return jsonResponse(400, { error: "theme_must_be_object" });
  }

  const bodyHash = await sha256Hex(bytes);

  // Atomically consume the nonce. Must have been issued to this address.
  let nonceOwner: string | null;
  try {
    nonceOwner = await consumeNonce(signed.nonce);
  } catch (err) {
    console.error(`[save] [${reqId}] consumeNonce failed:`, err);
    return jsonResponse(503, { error: "storage_unavailable" });
  }
  if (!nonceOwner || nonceOwner.toLowerCase() !== signed.address) {
    return jsonResponse(401, { error: "invalid_nonce" });
  }

  const message = buildWriteMessage(
    signed.address,
    bodyHash,
    signed.nonce,
    signed.timestamp,
  );
  const verified = await verifySignature(signed.address, message, signed.signature);
  if (!verified) return jsonResponse(401, { error: "signature_verification_failed" });

  if (!isStorageConfigured()) {
    console.error(`[save] [${reqId}] storage env vars are not fully set`);
    return jsonResponse(503, { error: "storage_not_configured" });
  }

  // If this hash already exists, return the existing URL without touching the
  // owner metadata or the owner index — content-addressed themes are immutable
  // and the first uploader keeps ownership (prevents ownership hijack via
  // re-upload of identical bytes).
  let existingMeta;
  try {
    existingMeta = await getThemeMeta(bodyHash);
  } catch (err) {
    console.error(`[save] [${reqId}] getThemeMeta failed:`, err);
    return jsonResponse(503, { error: "metadata_read_failed" });
  }
  if (existingMeta) {
    return successResponse(req, bodyHash);
  }

  // Per-owner quota check (only counts for the inserting owner; dedup hits
  // above this path don't add to the index).
  if (MAX_THEMES_PER_OWNER > 0) {
    let count: number;
    try {
      count = await countOwnerThemes(verified);
    } catch (err) {
      console.error(`[save] [${reqId}] countOwnerThemes failed:`, err);
      return jsonResponse(503, { error: "metadata_read_failed" });
    }
    if (count >= MAX_THEMES_PER_OWNER) {
      return jsonResponse(409, {
        error: "quota_exceeded",
        limit: MAX_THEMES_PER_OWNER,
      });
    }
  }

  const storage = getStorage();
  const contentType = "application/json";
  try {
    const existingBlob = await storage.headTheme(bodyHash);
    if (!existingBlob) {
      await storage.putTheme(bodyHash, bytes, contentType);
    }
  } catch (err) {
    console.error(`[save] [${reqId}] tigris write failed:`, err);
    return jsonResponse(502, { error: "storage_write_failed" });
  }

  const createdAt = Math.floor(Date.now() / 1000);
  try {
    await saveThemeMeta(bodyHash, {
      owner: verified,
      created_at: createdAt,
      size: bytes.byteLength,
      content_type: contentType,
    });
    await addOwnerIndex(verified, bodyHash, createdAt);
  } catch (err) {
    console.error(`[save] [${reqId}] metadata write failed:`, err);
    return jsonResponse(503, { error: "metadata_write_failed" });
  }

  return successResponse(req, bodyHash);
}

function successResponse(req: Request, bodyHash: string): Response {
  const res: SaveThemeResponse = {
    hash: bodyHash,
    url: `${originFor(req)}/themes/${bodyHash}`,
  };
  return jsonResponse(200, res as unknown as Record<string, unknown>);
}

/**
 * GET /themes/:hash
 */
export async function handleGetTheme(
  hash: string,
  reqId: string,
  headOnly = false,
): Promise<Response> {
  if (!isValidHash(hash)) return jsonResponse(400, { error: "invalid_hash" });
  if (headOnly) {
    let meta;
    try {
      meta = await getStorage().headTheme(hash);
    } catch (err) {
      console.error(`[get-head] [${reqId}] failed:`, err);
      return jsonResponse(502, { error: "storage_read_failed" });
    }
    if (!meta) return jsonResponse(404, { error: "not_found" });
    const headers = new Headers({
      "content-type": "application/json",
      "cache-control": THEME_CACHE_CONTROL,
      "access-control-allow-origin": "*",
    });
    if (meta.contentLength !== null) {
      headers.set("content-length", String(meta.contentLength));
    }
    return new Response(null, { status: 200, headers });
  }
  let obj;
  try {
    obj = await getStorage().getThemeStream(hash);
  } catch (err) {
    console.error(`[get] [${reqId}] failed:`, err);
    return jsonResponse(502, { error: "storage_read_failed" });
  }
  if (!obj) return jsonResponse(404, { error: "not_found" });
  const headers = new Headers({
    "content-type": obj.contentType,
    "cache-control": THEME_CACHE_CONTROL,
    "access-control-allow-origin": "*",
  });
  if (obj.contentLength !== null) {
    headers.set("content-length", String(obj.contentLength));
  }
  return new Response(obj.body, { status: 200, headers });
}

/**
 * GET /themes/:hash/meta
 */
export async function handleGetThemeMeta(hash: string): Promise<Response> {
  if (!isValidHash(hash)) return jsonResponse(400, { error: "invalid_hash" });
  let meta;
  try {
    meta = await getThemeMeta(hash);
  } catch {
    return jsonResponse(503, { error: "metadata_read_failed" });
  }
  if (!meta) return jsonResponse(404, { error: "not_found" });
  const res: ThemeMetaResponse = {
    owner: meta.owner,
    created_at: meta.created_at,
    size: meta.size,
  };
  return jsonResponse(200, res as unknown as Record<string, unknown>);
}

/**
 * GET /users/:address/themes?offset=N&limit=M
 */
export async function handleListOwnerThemes(
  address: string,
  url: URL,
): Promise<Response> {
  const addr = address.toLowerCase();
  if (!isValidAddress(addr)) return jsonResponse(400, { error: "invalid_address" });
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0") || 0);
  const limitParam = Number(url.searchParams.get("limit") ?? "50") || 50;
  const limit = Math.max(1, Math.min(200, limitParam));
  let hashes: string[];
  let total: number;
  try {
    [hashes, total] = await Promise.all([
      listOwnerThemes(addr, offset, limit),
      countOwnerThemes(addr),
    ]);
  } catch {
    return jsonResponse(503, { error: "metadata_read_failed" });
  }
  const nextOffset = offset + hashes.length < total ? offset + hashes.length : null;
  const res: ListOwnerThemesResponse = {
    address: addr,
    hashes,
    next_offset: nextOffset,
  };
  return jsonResponse(200, {
    ...res as unknown as Record<string, unknown>,
    total,
  });
}

/**
 * DELETE /themes/:hash
 */
export async function handleDeleteTheme(
  hash: string,
  req: Request,
  reqId: string,
): Promise<Response> {
  return await withTimeout(
    REQUEST_TIMEOUT_MS,
    () => deleteThemeImpl(hash, req, reqId),
    () => {
      console.warn(`[delete] [${reqId}] request timed out`);
      return jsonResponse(408, { error: "request_timeout" });
    },
  );
}

async function deleteThemeImpl(
  hash: string,
  req: Request,
  reqId: string,
): Promise<Response> {
  if (!isValidHash(hash)) return jsonResponse(400, { error: "invalid_hash" });

  const signed = extractSignedHeaders(req);
  if ("error" in signed) return jsonResponse(401, signed);

  let nonceOwner: string | null;
  try {
    nonceOwner = await consumeNonce(signed.nonce);
  } catch (err) {
    console.error(`[delete] [${reqId}] consumeNonce failed:`, err);
    return jsonResponse(503, { error: "storage_unavailable" });
  }
  if (!nonceOwner || nonceOwner.toLowerCase() !== signed.address) {
    return jsonResponse(401, { error: "invalid_nonce" });
  }

  const message = buildDeleteMessage(
    signed.address,
    hash,
    signed.nonce,
    signed.timestamp,
  );
  const verified = await verifySignature(signed.address, message, signed.signature);
  if (!verified) return jsonResponse(401, { error: "signature_verification_failed" });

  let meta;
  try {
    meta = await getThemeMeta(hash);
  } catch {
    return jsonResponse(503, { error: "metadata_read_failed" });
  }
  if (!meta) return jsonResponse(404, { error: "not_found" });
  if (meta.owner.toLowerCase() !== verified) {
    return jsonResponse(403, { error: "forbidden" });
  }

  // Delete Redis state FIRST so a failure between steps can only leave an
  // orphan blob (harmless cost) rather than a ghost-theme that public reads
  // would 404 on. The blob is content-addressed and immutable so deleting it
  // second is idempotent.
  try {
    await deleteThemeMeta(hash);
    await removeOwnerIndex(verified, hash);
  } catch (err) {
    console.error(`[delete] [${reqId}] metadata delete failed:`, err);
    return jsonResponse(503, { error: "metadata_delete_failed" });
  }
  try {
    await getStorage().deleteTheme(hash);
  } catch (err) {
    console.error(`[delete] [${reqId}] tigris delete failed (orphan blob):`, err);
    return jsonResponse(502, { error: "storage_delete_failed" });
  }

  return jsonResponse(200, { ok: true });
}
