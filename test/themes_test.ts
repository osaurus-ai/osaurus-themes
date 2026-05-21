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
  );
  const body = await res.json();
  return body.nonce as string;
}

async function buildSignedSaveRequest(
  bodyJson: Record<string, unknown>,
  addr: string,
): Promise<{ req: Request; bodyHash: string; nonce: string }> {
  const nonce = await getChallengeNonce(addr);
  const bytes = new TextEncoder().encode(JSON.stringify(bodyJson));
  const bodyHash = await sha256Hex(bytes);
  const timestamp = Math.floor(Date.now() / 1000);
  const message = buildWriteMessage(addr, bodyHash, nonce, timestamp);
  const signature = await account.signMessage({ message });
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

Deno.test("handleChallenge - returns nonce for valid address", async () => {
  setup();
  const res = await handleChallenge(
    new Request("http://test/auth/challenge", {
      method: "POST",
      body: JSON.stringify({ address: ADDR }),
    }),
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
  );
  assertEquals(res.status, 400);
});

Deno.test("handleSaveTheme - happy path stores blob + metadata", async () => {
  const { mock, storage } = setup();
  const { req, bodyHash } = await buildSignedSaveRequest({ name: "midnight" }, ADDR);
  const res = await handleSaveTheme(req);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.hash, bodyHash);
  assert(typeof body.url === "string" && body.url.endsWith(`/themes/${bodyHash}`));
  assertEquals(storage.blobs.has(bodyHash), true);
  const meta = mock.hashes.get(`theme:${bodyHash}`);
  assertEquals(meta?.owner, ADDR);
  assertEquals(Number(meta?.size) > 0, true);
});

Deno.test("handleSaveTheme - nonce is single-use", async () => {
  setup();
  const { req } = await buildSignedSaveRequest({ a: 1 }, ADDR);
  // Clone the request before consuming it (Request bodies can only be read once).
  const reqClone = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: await req.clone().arrayBuffer(),
  });
  const ok = await handleSaveTheme(req);
  assertEquals(ok.status, 200);

  const replay = await handleSaveTheme(reqClone);
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
  const res = await handleSaveTheme(req);
  assertEquals(res.status, 401);
  assertEquals((await res.json()).error, "signature_verification_failed");
});

Deno.test("handleSaveTheme - missing auth headers", async () => {
  setup();
  const res = await handleSaveTheme(
    new Request("http://test/themes", { method: "POST", body: "{}" }),
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
  );
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "empty_body");
});

Deno.test("handleSaveTheme - non-JSON body rejected", async () => {
  setup();
  const nonce = await getChallengeNonce(ADDR);
  const bytes = new TextEncoder().encode("not json");
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
  );
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "invalid_json");
});

Deno.test("handleSaveTheme - dedupes identical content", async () => {
  const { storage } = setup();
  // First save
  const a = await buildSignedSaveRequest({ same: true }, ADDR);
  const r1 = await handleSaveTheme(a.req);
  assertEquals(r1.status, 200);
  const putAfterFirst = storage.putCalls;

  // Second save with fresh nonce + signature, identical body
  const b = await buildSignedSaveRequest({ same: true }, ADDR);
  const r2 = await handleSaveTheme(b.req);
  assertEquals(r2.status, 200);
  assertEquals(storage.putCalls, putAfterFirst); // headTheme found it, no re-put
});

Deno.test("handleGetTheme - returns stored bytes", async () => {
  setup();
  const { req, bodyHash } = await buildSignedSaveRequest({ x: 1 }, ADDR);
  await handleSaveTheme(req);
  const res = await handleGetTheme(bodyHash);
  assertEquals(res.status, 200);
  const text = await res.text();
  assertEquals(text, JSON.stringify({ x: 1 }));
  assertEquals(res.headers.get("content-type"), "application/json");
});

Deno.test("handleGetTheme - 404 on missing", async () => {
  setup();
  const res = await handleGetTheme("0".repeat(64));
  assertEquals(res.status, 404);
});

Deno.test("handleGetTheme - 400 on bad hash format", async () => {
  setup();
  const res = await handleGetTheme("not-a-hash");
  assertEquals(res.status, 400);
});

Deno.test("handleGetThemeMeta - returns metadata", async () => {
  setup();
  const { req, bodyHash } = await buildSignedSaveRequest({ x: 1 }, ADDR);
  await handleSaveTheme(req);
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
  await handleSaveTheme(a.req);
  await new Promise((r) => setTimeout(r, 1100)); // ensure different created_at
  const b = await buildSignedSaveRequest({ n: 2 }, ADDR);
  await handleSaveTheme(b.req);

  const res = await handleListOwnerThemes(
    ADDR,
    new URL("http://test/users/x/themes"),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.address, ADDR);
  assertEquals(body.hashes[0], b.bodyHash);
  assertEquals(body.hashes[1], a.bodyHash);
});

Deno.test("handleDeleteTheme - owner can delete", async () => {
  const { storage } = setup();
  const saved = await buildSignedSaveRequest({ z: 1 }, ADDR);
  await handleSaveTheme(saved.req);

  const deleteNonce = await getChallengeNonce(ADDR);
  const ts = Math.floor(Date.now() / 1000);
  const msg = buildDeleteMessage(ADDR, saved.bodyHash, deleteNonce, ts);
  const sig = await account.signMessage({ message: msg });
  const req = new Request(`http://test/themes/${saved.bodyHash}`, {
    method: "DELETE",
    headers: {
      "x-agent-address": ADDR,
      "x-nonce": deleteNonce,
      "x-timestamp": String(ts),
      "x-signature": sig,
    },
  });
  const res = await handleDeleteTheme(saved.bodyHash, req);
  assertEquals(res.status, 200);
  assertEquals(storage.blobs.has(saved.bodyHash), false);
});

Deno.test("handleDeleteTheme - non-owner forbidden", async () => {
  setup();
  const saved = await buildSignedSaveRequest({ z: 1 }, ADDR);
  await handleSaveTheme(saved.req);

  const otherKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  const otherAccount = privateKeyToAccount(otherKey);
  const otherAddr = otherAccount.address.toLowerCase();

  const deleteNonce = await getChallengeNonce(otherAddr);
  const ts = Math.floor(Date.now() / 1000);
  const msg = buildDeleteMessage(otherAddr, saved.bodyHash, deleteNonce, ts);
  const sig = await otherAccount.signMessage({ message: msg });
  const req = new Request(`http://test/themes/${saved.bodyHash}`, {
    method: "DELETE",
    headers: {
      "x-agent-address": otherAddr,
      "x-nonce": deleteNonce,
      "x-timestamp": String(ts),
      "x-signature": sig,
    },
  });
  const res = await handleDeleteTheme(saved.bodyHash, req);
  assertEquals(res.status, 403);
});

Deno.test("handleDeleteTheme - 404 when missing", async () => {
  setup();
  const hash = "a".repeat(64);
  const nonce = await getChallengeNonce(ADDR);
  const ts = Math.floor(Date.now() / 1000);
  const msg = buildDeleteMessage(ADDR, hash, nonce, ts);
  const sig = await account.signMessage({ message: msg });
  const req = new Request(`http://test/themes/${hash}`, {
    method: "DELETE",
    headers: {
      "x-agent-address": ADDR,
      "x-nonce": nonce,
      "x-timestamp": String(ts),
      "x-signature": sig,
    },
  });
  const res = await handleDeleteTheme(hash, req);
  assertEquals(res.status, 404);
});
