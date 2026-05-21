import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { getOrGenerateRequestId, jsonResponse, readBodyBytes, withTimeout } from "../src/http.ts";

// --- jsonResponse ---

Deno.test("jsonResponse - sets CORS + content-type + extra headers", () => {
  const res = jsonResponse(418, { teapot: true }, { "x-request-id": "abc" });
  assertEquals(res.status, 418);
  assertEquals(res.headers.get("content-type"), "application/json");
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assertEquals(res.headers.get("x-request-id"), "abc");
});

// --- withTimeout ---

Deno.test("withTimeout - resolves when fn finishes before deadline", async () => {
  const result = await withTimeout(
    100,
    () => Promise.resolve("ok"),
    () => "timeout",
  );
  assertEquals(result, "ok");
});

Deno.test("withTimeout - calls onTimeout when fn exceeds deadline", async () => {
  const result = await withTimeout(
    20,
    (signal) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve("late"), 100);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
    () => "timeout",
  );
  assertEquals(result, "timeout");
});

Deno.test("withTimeout - propagates non-abort errors", async () => {
  let caught: unknown = null;
  try {
    await withTimeout(
      100,
      () => Promise.reject(new Error("boom")),
      () => "timeout",
    );
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof Error);
  assertEquals((caught as Error).message, "boom");
});

// --- readBodyBytes with signal ---

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

function slowStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    // Never produces a chunk; this is the slowloris simulation.
    start() {},
  });
}

Deno.test("readBodyBytes - reads full body when under cap", async () => {
  const req = new Request("http://t/", {
    method: "POST",
    body: streamFromBytes(new Uint8Array([1, 2, 3])),
  });
  const out = await readBodyBytes(req, 100);
  assertEquals(out, new Uint8Array([1, 2, 3]));
});

Deno.test("readBodyBytes - returns null when body exceeds cap", async () => {
  const big = new Uint8Array(200);
  const req = new Request("http://t/", { method: "POST", body: streamFromBytes(big) });
  const out = await readBodyBytes(req, 100);
  assertEquals(out, null);
});

Deno.test("readBodyBytes - throws AbortError when signal fires before completion", async () => {
  const req = new Request("http://t/", { method: "POST", body: slowStream() });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  let caught: unknown = null;
  try {
    await readBodyBytes(req, 1024, controller.signal);
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof DOMException || caught instanceof Error);
  assertEquals((caught as Error).name, "AbortError");
});

// --- getOrGenerateRequestId ---

Deno.test("getOrGenerateRequestId - echoes well-formed client header", () => {
  const req = new Request("http://t/", { headers: { "x-request-id": "client.req-123_ABC" } });
  assertEquals(getOrGenerateRequestId(req), "client.req-123_ABC");
});

Deno.test("getOrGenerateRequestId - generates when missing", () => {
  const req = new Request("http://t/");
  const id = getOrGenerateRequestId(req);
  assertEquals(id.startsWith("req_"), true);
  assertEquals(/^req_[0-9a-f]{16}$/.test(id), true);
});

Deno.test("getOrGenerateRequestId - rejects malformed header (e.g. spaces, very long)", () => {
  const req1 = new Request("http://t/", { headers: { "x-request-id": "has spaces" } });
  const id1 = getOrGenerateRequestId(req1);
  assertEquals(id1.startsWith("req_"), true);

  const req2 = new Request("http://t/", { headers: { "x-request-id": "x".repeat(200) } });
  const id2 = getOrGenerateRequestId(req2);
  assertEquals(id2.startsWith("req_"), true);
});
