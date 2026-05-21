import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildDeleteMessage,
  buildWriteMessage,
  generateNonce,
  isTimestampValid,
  verifySignature,
} from "../src/auth.ts";

const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(TEST_KEY);

Deno.test("generateNonce - 64 char hex", () => {
  const nonce = generateNonce();
  assertEquals(nonce.length, 64);
  assertEquals(/^[0-9a-f]{64}$/.test(nonce), true);
});

Deno.test("generateNonce - unique each call", () => {
  assertEquals(generateNonce() !== generateNonce(), true);
});

Deno.test("buildWriteMessage - canonical format", () => {
  const msg = buildWriteMessage("0xabc", "deadbeef", "n", 123);
  assertEquals(msg, "osaurus-theme:0xabc:deadbeef:n:123");
});

Deno.test("buildDeleteMessage - canonical format", () => {
  const msg = buildDeleteMessage("0xabc", "deadbeef", "n", 123);
  assertEquals(msg, "osaurus-theme-delete:0xabc:deadbeef:n:123");
});

Deno.test("isTimestampValid - within window", () => {
  const now = Math.floor(Date.now() / 1000);
  assertEquals(isTimestampValid(now), true);
  assertEquals(isTimestampValid(now - 25), true);
  assertEquals(isTimestampValid(now + 25), true);
});

Deno.test("isTimestampValid - outside window", () => {
  const now = Math.floor(Date.now() / 1000);
  assertEquals(isTimestampValid(now - 60), false);
  assertEquals(isTimestampValid(now + 60), false);
});

Deno.test("verifySignature - valid write signature", async () => {
  const nonce = generateNonce();
  const timestamp = Math.floor(Date.now() / 1000);
  const bodyHash = "a".repeat(64);
  const message = buildWriteMessage(account.address, bodyHash, nonce, timestamp);
  const signature = await account.signMessage({ message });

  const result = await verifySignature(account.address, message, signature);
  assertEquals(result, account.address.toLowerCase());
});

Deno.test("verifySignature - valid delete signature", async () => {
  const nonce = generateNonce();
  const timestamp = Math.floor(Date.now() / 1000);
  const hash = "b".repeat(64);
  const message = buildDeleteMessage(account.address, hash, nonce, timestamp);
  const signature = await account.signMessage({ message });

  const result = await verifySignature(account.address, message, signature);
  assertEquals(result, account.address.toLowerCase());
});

Deno.test("verifySignature - wrong address", async () => {
  const message = "osaurus-theme:0xabc:hash:nonce:1";
  const signature = await account.signMessage({ message });
  const fakeAddress = "0x0000000000000000000000000000000000000001";
  const result = await verifySignature(fakeAddress, message, signature);
  assertEquals(result, null);
});

Deno.test("verifySignature - tampered body hash rejected", async () => {
  const nonce = generateNonce();
  const timestamp = Math.floor(Date.now() / 1000);
  const realHash = "a".repeat(64);
  const tamperedHash = "b".repeat(64);
  const signedMsg = buildWriteMessage(account.address, realHash, nonce, timestamp);
  const signature = await account.signMessage({ message: signedMsg });

  // Server reconstructs message with the tampered body's hash; it won't match.
  const verifiedMsg = buildWriteMessage(account.address, tamperedHash, nonce, timestamp);
  const result = await verifySignature(account.address, verifiedMsg, signature);
  assertEquals(result, null);
});

Deno.test("verifySignature - malformed signature", async () => {
  const result = await verifySignature(account.address, "msg", "0xdeadbeef");
  assertEquals(result, null);
});
