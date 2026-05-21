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
  deleteThemeMeta,
  getThemeMeta,
  isRedisConfigured,
  issueNonce,
  listOwnerThemes,
  removeOwnerIndex,
  saveThemeMeta,
} from "./redis.ts";
import { getStorage, isStorageConfigured } from "./storage.ts";
import { jsonResponse, readBodyBytes } from "./http.ts";
import type {
  ChallengeRequest,
  ChallengeResponse,
  ListOwnerThemesResponse,
  SaveThemeResponse,
  ThemeMetaResponse,
} from "./types.ts";

export const MAX_THEME_BYTES = 5 * 1024 * 1024; // 5 MB
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

const BASE_URL = (Deno.env.get("BASE_URL") ?? "").replace(/\/+$/, "");

function isValidAddress(s: string): boolean {
  return ADDRESS_RE.test(s);
}

function isValidHash(s: string): boolean {
  return HASH_RE.test(s);
}

function originFor(req: Request): string {
  if (BASE_URL) return BASE_URL;
  const url = new URL(req.url);
  // Behind Fly's edge the connection to us is HTTP, but the public URL is HTTPS.
  // Default to https unless the host looks like localhost.
  const host = req.headers.get("host") ?? url.host;
  const proto = host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https";
  return `${proto}://${host}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Cast to BufferSource: at runtime these bytes are always backed by an
  // ArrayBuffer (allocated in readBodyBytes), never a SharedArrayBuffer.
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
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
 * Body: { address: "0x..." }
 * Issues a single-use nonce bound to the requesting address.
 */
export async function handleChallenge(req: Request): Promise<Response> {
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
    console.error("[challenge] REDIS_URL not configured");
    return jsonResponse(503, { error: "redis_not_configured" });
  }
  const nonce = generateNonce();
  try {
    await issueNonce(address, nonce);
  } catch (err) {
    console.error("[challenge] issueNonce failed:", err);
    return jsonResponse(503, { error: "storage_unavailable" });
  }
  const res: ChallengeResponse = { nonce, expires_in: 60 };
  return jsonResponse(200, res as unknown as Record<string, unknown>);
}

/**
 * POST /themes
 * Headers: x-agent-address, x-nonce, x-timestamp, x-signature
 * Body: raw theme JSON (5 MB max)
 */
export async function handleSaveTheme(req: Request): Promise<Response> {
  const signed = extractSignedHeaders(req);
  if ("error" in signed) return jsonResponse(401, signed);

  const bytes = await readBodyBytes(req, MAX_THEME_BYTES);
  if (bytes === null) return jsonResponse(413, { error: "body_too_large" });
  if (bytes.byteLength === 0) return jsonResponse(400, { error: "empty_body" });

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  if (parsed === null || typeof parsed !== "object") {
    return jsonResponse(400, { error: "theme_must_be_object" });
  }

  const bodyHash = await sha256Hex(bytes);

  // Atomically consume the nonce. Must have been issued to this address.
  let nonceOwner: string | null;
  try {
    nonceOwner = await consumeNonce(signed.nonce);
  } catch {
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
    console.error("[save] storage env vars are not fully set");
    return jsonResponse(503, { error: "storage_not_configured" });
  }
  const storage = getStorage();
  const contentType = "application/json";
  try {
    const existing = await storage.headTheme(bodyHash);
    if (!existing) {
      await storage.putTheme(bodyHash, bytes, contentType);
    }
  } catch (err) {
    console.error("[save] tigris write failed:", err);
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
  } catch {
    return jsonResponse(503, { error: "metadata_write_failed" });
  }

  const res: SaveThemeResponse = {
    hash: bodyHash,
    url: `${originFor(req)}/themes/${bodyHash}`,
  };
  return jsonResponse(200, res as unknown as Record<string, unknown>);
}

/**
 * GET /themes/:hash — public, streams the blob.
 */
export async function handleGetTheme(hash: string): Promise<Response> {
  if (!isValidHash(hash)) return jsonResponse(400, { error: "invalid_hash" });
  let obj;
  try {
    obj = await getStorage().getThemeStream(hash);
  } catch {
    return jsonResponse(502, { error: "storage_read_failed" });
  }
  if (!obj) return jsonResponse(404, { error: "not_found" });
  const headers = new Headers({
    "content-type": obj.contentType,
    "cache-control": "public, max-age=31536000, immutable",
    "access-control-allow-origin": "*",
  });
  if (obj.contentLength !== null) {
    headers.set("content-length", String(obj.contentLength));
  }
  return new Response(obj.body, { status: 200, headers });
}

/**
 * GET /themes/:hash/meta — public, returns owner + created_at + size.
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
 * GET /users/:address/themes?offset=N&limit=M — public listing.
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
  try {
    hashes = await listOwnerThemes(addr, offset, limit);
  } catch {
    return jsonResponse(503, { error: "metadata_read_failed" });
  }
  const res: ListOwnerThemesResponse = {
    address: addr,
    hashes,
    next_offset: hashes.length === limit ? offset + limit : null,
  };
  return jsonResponse(200, res as unknown as Record<string, unknown>);
}

/**
 * DELETE /themes/:hash — owner-only.
 */
export async function handleDeleteTheme(hash: string, req: Request): Promise<Response> {
  if (!isValidHash(hash)) return jsonResponse(400, { error: "invalid_hash" });

  const signed = extractSignedHeaders(req);
  if ("error" in signed) return jsonResponse(401, signed);

  let nonceOwner: string | null;
  try {
    nonceOwner = await consumeNonce(signed.nonce);
  } catch {
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

  try {
    await getStorage().deleteTheme(hash);
  } catch {
    return jsonResponse(502, { error: "storage_delete_failed" });
  }
  try {
    await deleteThemeMeta(hash);
    await removeOwnerIndex(verified, hash);
  } catch {
    return jsonResponse(503, { error: "metadata_delete_failed" });
  }

  return jsonResponse(200, { ok: true });
}
