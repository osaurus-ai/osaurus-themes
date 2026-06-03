// Long-lived caching for immutable, content-addressed theme blobs.
// `no-transform` is load-bearing: it disables Deno.serve's automatic
// gzip/brotli compression, which truncates the streamed S3 body over HTTP/2
// (Deno #19889) and surfaces on clients as NSURLErrorDomain -1005.
export const THEME_CACHE_CONTROL = "public, max-age=31536000, immutable, no-transform";

export function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  };
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) headers[k] = v;
  }
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Stream-reads a request body into a single Uint8Array. Returns null when the
 * body is too large; throws on signal abort (so the caller can produce a
 * 408 Request Timeout).
 */
export async function readBodyBytes(
  req: Request,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  if (signal) {
    if (signal.aborted) {
      reader.cancel().catch(() => {});
      throw new DOMException("request_timeout", "AbortError");
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    for (;;) {
      const { done, value } = await reader.read();
      // Check abort BEFORE done: a signal-triggered cancel() resolves the
      // pending read() with done=true, so without this check we'd silently
      // return the bytes accumulated so far instead of surfacing the timeout.
      if (signal?.aborted) throw new DOMException("request_timeout", "AbortError");
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * Wrap an async handler in a timeout. The handler receives an AbortSignal that
 * fires after `timeoutMs`; if it fires before the handler returns, the wrapper
 * resolves with `onTimeout()` instead.
 */
export async function withTimeout<T>(
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
  onTimeout: () => T,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) return onTimeout();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers":
    "content-type, authorization, x-agent-address, x-nonce, x-timestamp, x-signature, x-request-id",
  "access-control-expose-headers": "x-request-id",
  "access-control-max-age": "86400",
} as const;

export function corsPreflightResponse(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

const REQUEST_ID_RE = /^[A-Za-z0-9_.\-]{1,64}$/;

/**
 * Use the client's `X-Request-ID` if it's well-formed, otherwise generate a
 * fresh hex one. Bound length to prevent log-injection or unbounded growth.
 */
export function getOrGenerateRequestId(req: Request): string {
  const inbound = req.headers.get("x-request-id");
  if (inbound && REQUEST_ID_RE.test(inbound)) return inbound;
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return "req_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
