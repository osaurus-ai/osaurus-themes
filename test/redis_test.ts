import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _setClientForTesting,
  addOwnerIndex,
  consumeNonce,
  deleteThemeMeta,
  getThemeMeta,
  issueNonce,
  listOwnerThemes,
  removeOwnerIndex,
  saveThemeMeta,
} from "../src/redis.ts";
import { MockRedis } from "./redis_mock.ts";

const ADDR = "0xaabbccdd";

// --- nonces ---

Deno.test("issueNonce - stores address under nonce key with TTL", async () => {
  const mock = new MockRedis();
  _setClientForTesting(mock);

  await issueNonce(ADDR, "abc123");
  assertEquals(mock.store.get("nonce:abc123")?.value, ADDR);
});

Deno.test("consumeNonce - returns address and removes key", async () => {
  const mock = new MockRedis();
  _setClientForTesting(mock);

  await issueNonce(ADDR, "abc123");
  const owner = await consumeNonce("abc123");
  assertEquals(owner, ADDR);
  assertEquals(mock.store.has("nonce:abc123"), false);
});

Deno.test("consumeNonce - second consume returns null", async () => {
  const mock = new MockRedis();
  _setClientForTesting(mock);

  await issueNonce(ADDR, "abc123");
  await consumeNonce("abc123");
  const owner2 = await consumeNonce("abc123");
  assertEquals(owner2, null);
});

Deno.test("consumeNonce - missing nonce returns null", async () => {
  const mock = new MockRedis();
  _setClientForTesting(mock);

  assertEquals(await consumeNonce("never-issued"), null);
});

// --- theme metadata ---

Deno.test("saveThemeMeta + getThemeMeta - round trip", async () => {
  const mock = new MockRedis();
  _setClientForTesting(mock);

  const hash = "f".repeat(64);
  await saveThemeMeta(hash, {
    owner: ADDR,
    created_at: 1234567890,
    size: 4242,
    content_type: "application/json",
  });
  const meta = await getThemeMeta(hash);
  assertEquals(meta, {
    owner: ADDR,
    created_at: 1234567890,
    size: 4242,
    content_type: "application/json",
  });
});

Deno.test("getThemeMeta - missing returns null", async () => {
  const mock = new MockRedis();
  _setClientForTesting(mock);
  assertEquals(await getThemeMeta("e".repeat(64)), null);
});

Deno.test("deleteThemeMeta - removes metadata", async () => {
  const mock = new MockRedis();
  _setClientForTesting(mock);

  const hash = "f".repeat(64);
  await saveThemeMeta(hash, {
    owner: ADDR,
    created_at: 1,
    size: 1,
    content_type: "application/json",
  });
  await deleteThemeMeta(hash);
  assertEquals(await getThemeMeta(hash), null);
});

// --- owner index ---

Deno.test("addOwnerIndex + listOwnerThemes - newest first", async () => {
  const mock = new MockRedis();
  _setClientForTesting(mock);

  await addOwnerIndex(ADDR, "hash1", 100);
  await addOwnerIndex(ADDR, "hash2", 300);
  await addOwnerIndex(ADDR, "hash3", 200);

  const list = await listOwnerThemes(ADDR);
  assertEquals(list, ["hash2", "hash3", "hash1"]);
});

Deno.test("listOwnerThemes - offset + limit pagination", async () => {
  const mock = new MockRedis();
  _setClientForTesting(mock);

  for (let i = 0; i < 5; i++) {
    await addOwnerIndex(ADDR, `hash${i}`, i);
  }
  const page1 = await listOwnerThemes(ADDR, 0, 2);
  const page2 = await listOwnerThemes(ADDR, 2, 2);
  assertEquals(page1, ["hash4", "hash3"]);
  assertEquals(page2, ["hash2", "hash1"]);
});

Deno.test("removeOwnerIndex - removes a single hash", async () => {
  const mock = new MockRedis();
  _setClientForTesting(mock);

  await addOwnerIndex(ADDR, "hashA", 1);
  await addOwnerIndex(ADDR, "hashB", 2);
  await removeOwnerIndex(ADDR, "hashA");
  assertEquals(await listOwnerThemes(ADDR), ["hashB"]);
});
