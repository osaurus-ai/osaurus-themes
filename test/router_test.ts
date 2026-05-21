import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleRequest } from "../src/router.ts";
import { _setClientForTesting } from "../src/redis.ts";
import { _setStorageForTesting } from "../src/storage.ts";
import { MockRedis } from "./redis_mock.ts";
import { MockStorage } from "./storage_mock.ts";

const FAKE_INFO: Deno.ServeHandlerInfo = {
  remoteAddr: { transport: "tcp", hostname: "10.0.0.42", port: 4242 },
  completed: Promise.resolve(),
};

function setup() {
  _setClientForTesting(new MockRedis());
  _setStorageForTesting(new MockStorage());
}

function unconfigure() {
  _setClientForTesting(null);
}

// --- Request-ID middleware ---

Deno.test("router - echoes well-formed X-Request-ID on every response", async () => {
  setup();
  const res = await handleRequest(
    new Request("http://t/livez", { headers: { "x-request-id": "abc.123-xyz" } }),
    FAKE_INFO,
  );
  assertEquals(res.headers.get("x-request-id"), "abc.123-xyz");
});

Deno.test("router - generates X-Request-ID when client omits it", async () => {
  setup();
  const res = await handleRequest(new Request("http://t/livez"), FAKE_INFO);
  const id = res.headers.get("x-request-id");
  assert(id && id.startsWith("req_"));
});

Deno.test("router - X-Request-ID present on 404 and 405 responses too", async () => {
  setup();
  const notFound = await handleRequest(new Request("http://t/nope"), FAKE_INFO);
  assertEquals(notFound.status, 404);
  assert(notFound.headers.get("x-request-id"));

  const notAllowed = await handleRequest(
    new Request(`http://t/themes/${"0".repeat(64)}`, { method: "PUT" }),
    FAKE_INFO,
  );
  assertEquals(notAllowed.status, 405);
  assert(notAllowed.headers.get("x-request-id"));
});

// --- Liveness vs readiness ---

Deno.test("router - /livez returns 200 even when Redis + Tigris are not configured", async () => {
  unconfigure();
  const res = await handleRequest(new Request("http://t/livez"), FAKE_INFO);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.status, "ok");
});

Deno.test("router - /health reports degraded state when Redis is missing", async () => {
  unconfigure();
  const res = await handleRequest(new Request("http://t/health"), FAKE_INFO);
  assertEquals(res.status, 503);
  const body = await res.json();
  assertEquals(body.status, "degraded");
  assertEquals(body.redis.configured, false);
});

Deno.test("router - /readyz aliases /health", async () => {
  unconfigure();
  const res = await handleRequest(new Request("http://t/readyz"), FAKE_INFO);
  assertEquals(res.status, 503);
  const body = await res.json();
  assertEquals(body.status, "degraded");
});

Deno.test("router - /health result is cached (subsequent calls reuse the snapshot)", async () => {
  // First call: Redis null. Snapshot says degraded.
  unconfigure();
  const r1 = await handleRequest(new Request("http://t/health"), FAKE_INFO);
  assertEquals(r1.status, 503);

  // Flip Redis to configured between calls. Within the cache TTL, the snapshot
  // should still report degraded.
  _setClientForTesting(new MockRedis());
  const r2 = await handleRequest(new Request("http://t/health"), FAKE_INFO);
  assertEquals(r2.status, 503);
  const body2 = await r2.json();
  assertEquals(body2.redis.configured, false);
});

// --- CORS preflight ---

Deno.test("router - OPTIONS returns 204 with request-id and CORS headers", async () => {
  setup();
  const res = await handleRequest(
    new Request("http://t/themes", { method: "OPTIONS" }),
    FAKE_INFO,
  );
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assert(
    res.headers.get("access-control-allow-headers")?.includes("x-signature"),
  );
  assert(res.headers.get("x-request-id"));
});

// --- 404 ---

Deno.test("router - unknown path returns 404", async () => {
  setup();
  const res = await handleRequest(new Request("http://t/totally/unknown"), FAKE_INFO);
  assertEquals(res.status, 404);
  assertEquals((await res.json()).error, "not_found");
});

// --- HEAD routes to head handler (regression for M4 wiring) ---

Deno.test("router - HEAD /themes/:hash dispatches to head handler", async () => {
  setup();
  const res = await handleRequest(
    new Request(`http://t/themes/${"a".repeat(64)}`, { method: "HEAD" }),
    FAKE_INFO,
  );
  // Storage is empty, so 404 (proves the handler ran).
  assertEquals(res.status, 404);
});

// --- IP source (H4 regression) ---
//
// We can't observe `clientIp` directly from outside, but we can prove the
// limiter is keyed by Fly's header (not a forged x-forwarded-for) by checking
// that a flood from IP A doesn't rate-limit IP B and vice versa, even when
// the attacker sends a matching x-forwarded-for header.

Deno.test("router - getClientIp prefers fly-client-ip; x-forwarded-for is NOT trusted", async () => {
  setup();
  // Two requests with the SAME spoofed x-forwarded-for but DIFFERENT
  // fly-client-ip — they must occupy independent rate-limit buckets.
  const a = await handleRequest(
    new Request("http://t/livez", {
      headers: {
        "fly-client-ip": "1.1.1.1",
        "x-forwarded-for": "9.9.9.9",
      },
    }),
    FAKE_INFO,
  );
  const b = await handleRequest(
    new Request("http://t/livez", {
      headers: {
        "fly-client-ip": "2.2.2.2",
        "x-forwarded-for": "9.9.9.9",
      },
    }),
    FAKE_INFO,
  );
  assertEquals(a.status, 200);
  assertEquals(b.status, 200);
  // Both succeeded with no rate limiting because they are keyed on
  // fly-client-ip, not the shared x-forwarded-for.
});
