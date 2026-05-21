import { corsPreflightResponse, getOrGenerateRequestId, jsonResponse } from "./http.ts";
import { challengeLimiter, readLimiter, writeLimiter } from "./rate_limit.ts";
import {
  handleChallenge,
  handleDeleteTheme,
  handleGetTheme,
  handleGetThemeMeta,
  handleListOwnerThemes,
  handleSaveTheme,
} from "./themes.ts";
import { isRedisConfigured, pingRedis } from "./redis.ts";
import { checkBucketReachable, isStorageConfigured } from "./storage.ts";

// On Fly, the edge proxy always sets fly-client-ip and cannot be spoofed.
// x-forwarded-for is set by anyone in front of us (Fly only adds to it, doesn't
// reset it), so we no longer fall back to it.
function getClientIp(req: Request, info: Deno.ServeHandlerInfo): string {
  const flyIp = req.headers.get("fly-client-ip");
  if (flyIp) return flyIp;
  const addr = info.remoteAddr;
  if (addr.transport === "tcp" || addr.transport === "udp") {
    return addr.hostname;
  }
  return "unknown";
}

const THEME_PATH_RE = /^\/themes\/([0-9a-f]{64})(?:\/(meta))?\/?$/;
const USER_THEMES_PATH_RE = /^\/users\/(0x[0-9a-fA-F]{40})\/themes\/?$/;

const HEALTH_CACHE_MS = 5_000;
interface HealthSnapshot {
  expiresAt: number;
  body: Record<string, unknown>;
  status: number;
}
let healthCache: HealthSnapshot | null = null;

async function buildHealthSnapshot(): Promise<HealthSnapshot> {
  const redisConfigured = isRedisConfigured();
  const storageConfigured = isStorageConfigured();
  const [redisOk, storageErr] = await Promise.all([
    redisConfigured ? pingRedis() : Promise.resolve(false),
    storageConfigured ? checkBucketReachable() : Promise.resolve("not_configured"),
  ]);
  const storageOk = storageErr === null;
  const ok = redisConfigured && redisOk && storageConfigured && storageOk;
  return {
    expiresAt: Date.now() + HEALTH_CACHE_MS,
    status: ok ? 200 : 503,
    body: {
      status: ok ? "ok" : "degraded",
      redis: { configured: redisConfigured, reachable: redisOk },
      storage: {
        configured: storageConfigured,
        reachable: storageOk,
        error: storageErr ?? undefined,
      },
    },
  };
}

async function readinessResponse(reqId: string): Promise<Response> {
  if (!healthCache || healthCache.expiresAt <= Date.now()) {
    healthCache = await buildHealthSnapshot();
  }
  return jsonResponse(healthCache.status, healthCache.body, { "x-request-id": reqId });
}

export async function handleRequest(
  req: Request,
  info: Deno.ServeHandlerInfo,
): Promise<Response> {
  const reqId = getOrGenerateRequestId(req);
  const url = new URL(req.url);
  const clientIp = getClientIp(req, info);

  if (req.method === "OPTIONS") {
    const res = corsPreflightResponse();
    res.headers.set("x-request-id", reqId);
    return res;
  }

  // Liveness: in-process only, never touches Redis/Tigris. Use for Fly's
  // built-in machine health checks so a dependency hiccup doesn't kill the VM.
  if (url.pathname === "/livez") {
    return jsonResponse(200, { status: "ok" }, { "x-request-id": reqId });
  }

  // Readiness / deep health. Cached for HEALTH_CACHE_MS so external monitors
  // can't accidentally hammer Redis + Tigris.
  if (url.pathname === "/health" || url.pathname === "/readyz") {
    return await readinessResponse(reqId);
  }

  let res: Response;

  if (url.pathname === "/auth/challenge" && req.method === "POST") {
    if (!challengeLimiter.allow(clientIp)) {
      res = jsonResponse(429, { error: "rate_limited" });
    } else {
      res = await handleChallenge(req, reqId);
    }
  } else if (url.pathname === "/themes" && req.method === "POST") {
    const address = req.headers.get("x-agent-address")?.toLowerCase();
    const writeKey = address ?? clientIp;
    if (!writeLimiter.allow(writeKey)) {
      res = jsonResponse(429, { error: "rate_limited" });
    } else {
      res = await handleSaveTheme(req, reqId);
    }
  } else {
    const themeMatch = url.pathname.match(THEME_PATH_RE);
    const userMatch = themeMatch ? null : url.pathname.match(USER_THEMES_PATH_RE);

    if (themeMatch) {
      const [, hash, suffix] = themeMatch;
      if (req.method === "GET" || req.method === "HEAD") {
        if (!readLimiter.allow(clientIp)) {
          res = jsonResponse(429, { error: "rate_limited" });
        } else if (suffix === "meta") {
          res = await handleGetThemeMeta(hash);
        } else {
          res = await handleGetTheme(hash, reqId, req.method === "HEAD");
        }
      } else if (req.method === "DELETE" && !suffix) {
        const address = req.headers.get("x-agent-address")?.toLowerCase();
        const writeKey = address ?? clientIp;
        if (!writeLimiter.allow(writeKey)) {
          res = jsonResponse(429, { error: "rate_limited" });
        } else {
          res = await handleDeleteTheme(hash, req, reqId);
        }
      } else {
        res = jsonResponse(405, { error: "method_not_allowed" });
      }
    } else if (userMatch && req.method === "GET") {
      if (!readLimiter.allow(clientIp)) {
        res = jsonResponse(429, { error: "rate_limited" });
      } else {
        res = await handleListOwnerThemes(userMatch[1], url);
      }
    } else {
      res = jsonResponse(404, { error: "not_found" });
    }
  }

  res.headers.set("x-request-id", reqId);
  if (res.status >= 500 || res.status === 408 || res.status === 429) {
    console.warn(
      `[req] [${reqId}] ${req.method} ${url.pathname} ip=${clientIp} status=${res.status}`,
    );
  }
  return res;
}
