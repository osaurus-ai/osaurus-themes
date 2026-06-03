import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { privateKeyToAccount } from "viem/accounts";
import { _setClientForTesting } from "../src/redis.ts";
import { _setStorageForTesting } from "../src/storage.ts";
import { buildDeleteMessage, buildWriteMessage } from "../src/auth.ts";
import {
  handleChallenge,
  handleDeleteTheme,
  handleGetTheme,
  handleGetThemeMeta,
  handleListOwnerThemes,
  handleSaveTheme,
} from "../src/themes.ts";
import { MockRedis } from "./redis_mock.ts";
import { MockStorage } from "./storage_mock.ts";

const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(TEST_KEY);
const ADDR = account.address.toLowerCase();
const RID = "req_test";

const OTHER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const otherAccount = privateKeyToAccount(OTHER_KEY);
const OTHER_ADDR = otherAccount.address.toLowerCase();

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function setup(): { mock: MockRedis; storage: MockStorage } {
  const mock = new MockRedis();
  const storage = new MockStorage();
  _setClientForTesting(mock);
  _setStorageForTesting(storage);
  return { mock, storage };
}

async function getChallengeNonce(addr: string): Promise<string> {
  const res = await handleChallenge(
    new Request("http://test/auth/challenge", {
      method: "POST",
      body: JSON.stringify({ address: addr }),
    }),
    RID,
  );
  const body = await res.json();
  return body.nonce as string;
}

async function buildSignedSaveRequest(
  bodyJson: Record<string, unknown>,
  addr: string,
  signer = account,
): Promise<{ req: Request; bodyHash: string; nonce: string }> {
  const nonce = await getChallengeNonce(addr);
  const bytes = new TextEncoder().encode(JSON.stringify(bodyJson));
  const bodyHash = await sha256Hex(bytes);
  const timestamp = Math.floor(Date.now() / 1000);
  const message = buildWriteMessage(addr, bodyHash, nonce, timestamp);
  const signature = await signer.signMessage({ message });
  const req = new Request("http://test/themes", {
    method: "POST",
    headers: {
      "x-agent-address": addr,
      "x-nonce": nonce,
      "x-timestamp": String(timestamp),
      "x-signature": signature,
      "content-type": "application/json",
    },
    body: bytes,
  });
  return { req, bodyHash, nonce };
}

async function buildDeleteRequest(
  hash: string,
  addr: string,
  signer = account,
): Promise<Request> {
  const nonce = await getChallengeNonce(addr);
  const ts = Math.floor(Date.now() / 1000);
  const msg = buildDeleteMessage(addr, hash, nonce, ts);
  const sig = await signer.signMessage({ message: msg });
  return new Request(`http://test/themes/${hash}`, {
    method: "DELETE",
    headers: {
      "x-agent-address": addr,
      "x-nonce": nonce,
      "x-timestamp": String(ts),
      "x-signature": sig,
    },
  });
}

Deno.test("handleChallenge - returns nonce for valid address", async () => {
  setup();
  const res = await handleChallenge(
    new Request("http://test/auth/challenge", {
      method: "POST",
      body: JSON.stringify({ address: ADDR }),
    }),
    RID,
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(/^[0-9a-f]{64}$/.test(body.nonce), true);
  assertEquals(body.expires_in, 60);
});

Deno.test("handleChallenge - rejects invalid address", async () => {
  setup();
  const res = await handleChallenge(
    new Request("http://test/auth/challenge", {
      method: "POST",
      body: JSON.stringify({ address: "not-an-address" }),
    }),
    RID,
  );
  assertEquals(res.status, 400);
});

Deno.test("handleSaveTheme - happy path stores blob + metadata", async () => {
  const { mock, storage } = setup();
  const { req, bodyHash } = await buildSignedSaveRequest({ name: "midnight" }, ADDR);
  const res = await handleSaveTheme(req, RID);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.hash, bodyHash);
  assert(typeof body.url === "string" && body.url.endsWith(`/themes/${bodyHash}`));
  assertEquals(storage.blobs.has(bodyHash), true);
  const meta = mock.hashes.get(`theme:${bodyHash}`);
  assertEquals(meta?.owner, ADDR);
  assertEquals(Number(meta?.size) > 0, true);
});

// --- H1 / L2: URL derivation from request when BASE_URL is unset ---

async function buildSignedSaveRequestWithHost(
  bodyJson: Record<string, unknown>,
  addr: string,
  host: string,
): Promise<{ req: Request; bodyHash: string }> {
  const nonce = await getChallengeNonce(addr);
  const bytes = new TextEncoder().encode(JSON.stringify(bodyJson));
  const bodyHash = await sha256Hex(bytes);
  const timestamp = Math.floor(Date.now() / 1000);
  const message = buildWriteMessage(addr, bodyHash, nonce, timestamp);
  const signature = await account.signMessage({ message });
  const req = new Request(`http://${host}/themes`, {
    method: "POST",
    headers: {
      host,
      "x-agent-address": addr,
      "x-nonce": nonce,
      "x-timestamp": String(timestamp),
      "x-signature": signature,
      "content-type": "application/json",
    },
    body: bytes,
  });
  return { req, bodyHash };
}

Deno.test("handleSaveTheme - URL uses https for non-local Host header", async () => {
  setup();
  const { req, bodyHash } = await buildSignedSaveRequestWithHost(
    { h: 1 },
    ADDR,
    "themes.osaurus.ai",
  );
  const res = await handleSaveTheme(req, RID);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.url, `https://themes.osaurus.ai/themes/${bodyHash}`);
});

Deno.test("handleSaveTheme - URL uses http only for literal localhost (L2)", async () => {
  setup();
  const a = await buildSignedSaveRequestWithHost({ h: 2 }, ADDR, "localhost:8080");
  const ra = await handleSaveTheme(a.req, RID);
  const ba = await ra.json();
  assertEquals(ba.url, `http://localhost:8080/themes/${a.bodyHash}`);

  // L2: "localhost.evil.com" must NOT be considered local
  const b = await buildSignedSaveRequestWithHost({ h: 3 }, ADDR, "localhost.evil.com");
  const rb = await handleSaveTheme(b.req, RID);
  const bb = await rb.json();
  assertEquals(bb.url, `https://localhost.evil.com/themes/${b.bodyHash}`);
});

Deno.test("handleSaveTheme - nonce is single-use", async () => {
  setup();
  const { req } = await buildSignedSaveRequest({ a: 1 }, ADDR);
  const reqClone = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: await req.clone().arrayBuffer(),
  });
  const ok = await handleSaveTheme(req, RID);
  assertEquals(ok.status, 200);

  const replay = await handleSaveTheme(reqClone, RID);
  assertEquals(replay.status, 401);
  assertEquals((await replay.json()).error, "invalid_nonce");
});

Deno.test("handleSaveTheme - tampered body rejected (signature binds to hash)", async () => {
  setup();
  const nonce = await getChallengeNonce(ADDR);
  const realBytes = new TextEncoder().encode(JSON.stringify({ legit: true }));
  const realHash = await sha256Hex(realBytes);
  const timestamp = Math.floor(Date.now() / 1000);
  const message = buildWriteMessage(ADDR, realHash, nonce, timestamp);
  const signature = await account.signMessage({ message });

  const tamperedBytes = new TextEncoder().encode(JSON.stringify({ evil: true }));
  const req = new Request("http://test/themes", {
    method: "POST",
    headers: {
      "x-agent-address": ADDR,
      "x-nonce": nonce,
      "x-timestamp": String(timestamp),
      "x-signature": signature,
    },
    body: tamperedBytes,
  });
  const res = await handleSaveTheme(req, RID);
  assertEquals(res.status, 401);
  assertEquals((await res.json()).error, "signature_verification_failed");
});

Deno.test("handleSaveTheme - missing auth headers", async () => {
  setup();
  const res = await handleSaveTheme(
    new Request("http://test/themes", { method: "POST", body: "{}" }),
    RID,
  );
  assertEquals(res.status, 401);
  assertEquals((await res.json()).error, "missing_auth_headers");
});

Deno.test("handleSaveTheme - empty body rejected", async () => {
  setup();
  const nonce = await getChallengeNonce(ADDR);
  const timestamp = Math.floor(Date.now() / 1000);
  const bodyHash = await sha256Hex(new Uint8Array(0));
  const message = buildWriteMessage(ADDR, bodyHash, nonce, timestamp);
  const signature = await account.signMessage({ message });
  const res = await handleSaveTheme(
    new Request("http://test/themes", {
      method: "POST",
      headers: {
        "x-agent-address": ADDR,
        "x-nonce": nonce,
        "x-timestamp": String(timestamp),
        "x-signature": signature,
      },
    }),
    RID,
  );
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "empty_body");
});

Deno.test("handleSaveTheme - non-object body rejected", async () => {
  setup();
  const nonce = await getChallengeNonce(ADDR);
  const bytes = new TextEncoder().encode("[1, 2, 3]");
  const bodyHash = await sha256Hex(bytes);
  const timestamp = Math.floor(Date.now() / 1000);
  const message = buildWriteMessage(ADDR, bodyHash, nonce, timestamp);
  const signature = await account.signMessage({ message });
  const res = await handleSaveTheme(
    new Request("http://test/themes", {
      method: "POST",
      headers: {
        "x-agent-address": ADDR,
        "x-nonce": nonce,
        "x-timestamp": String(timestamp),
        "x-signature": signature,
      },
      body: bytes,
    }),
    RID,
  );
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "theme_must_be_object");
});

Deno.test("handleSaveTheme - dedupes identical content from same owner", async () => {
  const { storage } = setup();
  const a = await buildSignedSaveRequest({ same: true }, ADDR);
  const r1 = await handleSaveTheme(a.req, RID);
  assertEquals(r1.status, 200);
  const putAfterFirst = storage.putCalls;

  const b = await buildSignedSaveRequest({ same: true }, ADDR);
  const r2 = await handleSaveTheme(b.req, RID);
  assertEquals(r2.status, 200);
  assertEquals(storage.putCalls, putAfterFirst);
});

// --- C1: ownership hijack regression ---

Deno.test("handleSaveTheme - second uploader CANNOT take over ownership", async () => {
  const { mock, storage } = setup();
  const first = await buildSignedSaveRequest({ shared: 1 }, ADDR);
  const r1 = await handleSaveTheme(first.req, RID);
  assertEquals(r1.status, 200);

  const putsBefore = storage.putCalls;
  const second = await buildSignedSaveRequest({ shared: 1 }, OTHER_ADDR, otherAccount);
  const r2 = await handleSaveTheme(second.req, RID);
  assertEquals(r2.status, 200);
  const body = await r2.json();
  assertEquals(body.hash, first.bodyHash);

  // Owner metadata must still be the first uploader.
  const meta = mock.hashes.get(`theme:${first.bodyHash}`);
  assertEquals(meta?.owner, ADDR);
  // Owner index must NOT include the second uploader.
  assertEquals(mock.zsets.get(`themes_by_owner:${OTHER_ADDR}`)?.has(first.bodyHash), undefined);
  // No additional blob put.
  assertEquals(storage.putCalls, putsBefore);

  // And the second uploader can NOT delete what they don't own.
  const delReq = await buildDeleteRequest(first.bodyHash, OTHER_ADDR, otherAccount);
  const delRes = await handleDeleteTheme(first.bodyHash, delReq, RID);
  assertEquals(delRes.status, 403);
  assertEquals(storage.blobs.has(first.bodyHash), true);
});

// --- H2: quota ---

Deno.test("handleSaveTheme - enforces MAX_THEMES_PER_OWNER", async () => {
  const { mock } = setup();
  const limit = Number(Deno.env.get("MAX_THEMES_PER_OWNER") ?? "1000");
  // Pre-populate the owner index up to the limit so the next save trips it.
  const zset = new Map<string, number>();
  for (let i = 0; i < limit; i++) zset.set(`prefill_hash_${i}`, i);
  mock.zsets.set(`themes_by_owner:${ADDR}`, zset);

  const { req } = await buildSignedSaveRequest({ over: true }, ADDR);
  const res = await handleSaveTheme(req, RID);
  assertEquals(res.status, 409);
  const body = await res.json();
  assertEquals(body.error, "quota_exceeded");
  assertEquals(body.limit, limit);
});

Deno.test("handleGetTheme - returns stored bytes", async () => {
  setup();
  const { req, bodyHash } = await buildSignedSaveRequest({ x: 1 }, ADDR);
  await handleSaveTheme(req, RID);
  const res = await handleGetTheme(bodyHash, RID);
  assertEquals(res.status, 200);
  const text = await res.text();
  assertEquals(text, JSON.stringify({ x: 1 }));
  assertEquals(res.headers.get("content-type"), "application/json");
  // no-transform must be present so Deno.serve does not auto-compress the
  // streamed body (compression truncates the HTTP/2 stream -> client -1005).
  assert(res.headers.get("cache-control")?.includes("no-transform"));
});

// --- M4: HEAD ---

Deno.test("handleGetTheme - HEAD returns headers only with no body", async () => {
  setup();
  const { req, bodyHash } = await buildSignedSaveRequest({ x: 1 }, ADDR);
  await handleSaveTheme(req, RID);
  const res = await handleGetTheme(bodyHash, RID, true);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "application/json");
  assert(res.headers.get("content-length") !== null);
  // body should be empty
  const text = await res.text();
  assertEquals(text, "");
});

Deno.test("handleGetTheme - HEAD 404 on missing", async () => {
  setup();
  const res = await handleGetTheme("0".repeat(64), RID, true);
  assertEquals(res.status, 404);
});

Deno.test("handleGetTheme - 404 on missing", async () => {
  setup();
  const res = await handleGetTheme("0".repeat(64), RID);
  assertEquals(res.status, 404);
});

Deno.test("handleGetTheme - 400 on bad hash format", async () => {
  setup();
  const res = await handleGetTheme("not-a-hash", RID);
  assertEquals(res.status, 400);
});

Deno.test("handleGetThemeMeta - returns metadata", async () => {
  setup();
  const { req, bodyHash } = await buildSignedSaveRequest({ x: 1 }, ADDR);
  await handleSaveTheme(req, RID);
  const res = await handleGetThemeMeta(bodyHash);
  assertEquals(res.status, 200);
  const meta = await res.json();
  assertEquals(meta.owner, ADDR);
  assertEquals(typeof meta.created_at, "number");
  assertEquals(typeof meta.size, "number");
});

Deno.test("handleListOwnerThemes - lists in newest-first order", async () => {
  setup();
  const a = await buildSignedSaveRequest({ n: 1 }, ADDR);
  await handleSaveTheme(a.req, RID);
  await new Promise((r) => setTimeout(r, 1100));
  const b = await buildSignedSaveRequest({ n: 2 }, ADDR);
  await handleSaveTheme(b.req, RID);

  const res = await handleListOwnerThemes(
    ADDR,
    new URL("http://test/users/x/themes"),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.address, ADDR);
  assertEquals(body.hashes[0], b.bodyHash);
  assertEquals(body.hashes[1], a.bodyHash);
  assertEquals(body.total, 2);
  assertEquals(body.next_offset, null);
});

// --- M3: pagination next_offset ---

Deno.test("handleListOwnerThemes - next_offset null at exact page boundary", async () => {
  const { mock } = setup();
  const zset = new Map<string, number>();
  for (let i = 0; i < 4; i++) zset.set(`hash_${i}`, i);
  mock.zsets.set(`themes_by_owner:${ADDR}`, zset);

  const res1 = await handleListOwnerThemes(
    ADDR,
    new URL("http://test/users/x/themes?limit=2&offset=0"),
  );
  const body1 = await res1.json();
  assertEquals(body1.next_offset, 2);
  assertEquals(body1.total, 4);

  const res2 = await handleListOwnerThemes(
    ADDR,
    new URL("http://test/users/x/themes?limit=2&offset=2"),
  );
  const body2 = await res2.json();
  // Page fills exactly but total = offset+returned, so no next page.
  assertEquals(body2.next_offset, null);
  assertEquals(body2.hashes.length, 2);
});

Deno.test("handleDeleteTheme - owner can delete", async () => {
  const { storage } = setup();
  const saved = await buildSignedSaveRequest({ z: 1 }, ADDR);
  await handleSaveTheme(saved.req, RID);
  const req = await buildDeleteRequest(saved.bodyHash, ADDR);
  const res = await handleDeleteTheme(saved.bodyHash, req, RID);
  assertEquals(res.status, 200);
  assertEquals(storage.blobs.has(saved.bodyHash), false);
});

Deno.test("handleDeleteTheme - non-owner forbidden", async () => {
  setup();
  const saved = await buildSignedSaveRequest({ z: 1 }, ADDR);
  await handleSaveTheme(saved.req, RID);
  const req = await buildDeleteRequest(saved.bodyHash, OTHER_ADDR, otherAccount);
  const res = await handleDeleteTheme(saved.bodyHash, req, RID);
  assertEquals(res.status, 403);
});

Deno.test("handleDeleteTheme - 404 when missing", async () => {
  setup();
  const hash = "a".repeat(64);
  const req = await buildDeleteRequest(hash, ADDR);
  const res = await handleDeleteTheme(hash, req, RID);
  assertEquals(res.status, 404);
});

// --- C2: delete order leaves no ghost-theme ---

Deno.test("handleDeleteTheme - Redis cleared before Tigris (no ghost-theme)", async () => {
  const { mock, storage } = setup();
  const saved = await buildSignedSaveRequest({ ghost: 1 }, ADDR);
  await handleSaveTheme(saved.req, RID);

  // Replace storage with a mock that fails delete. After the failing delete,
  // Redis state MUST already be cleared so GET /themes/:hash/meta returns 404.
  class FailingDeleteStorage extends MockStorage {
    override deleteTheme(_hash: string): Promise<void> {
      return Promise.reject(new Error("simulated_tigris_outage"));
    }
  }
  const failing = new FailingDeleteStorage();
  for (const [k, v] of storage.blobs.entries()) failing.blobs.set(k, v);
  _setStorageForTesting(failing);

  const req = await buildDeleteRequest(saved.bodyHash, ADDR);
  const res = await handleDeleteTheme(saved.bodyHash, req, RID);
  assertEquals(res.status, 502);
  // Metadata is gone — no ghost-theme.
  assertEquals(mock.hashes.has(`theme:${saved.bodyHash}`), false);
  assertEquals(
    mock.zsets.get(`themes_by_owner:${ADDR}`)?.has(saved.bodyHash) ?? false,
    false,
  );
});
