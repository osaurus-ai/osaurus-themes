import { corsPreflightResponse, jsonResponse } from "./http.ts";
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

function getClientIp(req: Request, info: Deno.ServeHandlerInfo): string {
  const flyIp = req.headers.get("fly-client-ip");
  if (flyIp) return flyIp;
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  const addr = info.remoteAddr;
  if (addr.transport === "tcp" || addr.transport === "udp") {
    return addr.hostname;
  }
  return "unknown";
}

const THEME_PATH_RE = /^\/themes\/([0-9a-f]{64})(?:\/(meta))?\/?$/;
const USER_THEMES_PATH_RE = /^\/users\/(0x[0-9a-fA-F]{40})\/themes\/?$/;

export async function handleRequest(
  req: Request,
  info: Deno.ServeHandlerInfo,
): Promise<Response> {
  const url = new URL(req.url);
  const clientIp = getClientIp(req, info);

  if (req.method === "OPTIONS") return corsPreflightResponse();

  if (url.pathname === "/health") {
    const redisConfigured = isRedisConfigured();
    const storageConfigured = isStorageConfigured();
    const [redisOk, storageErr] = await Promise.all([
      redisConfigured ? pingRedis() : Promise.resolve(false),
      storageConfigured ? checkBucketReachable() : Promise.resolve("not_configured"),
    ]);
    const storageOk = storageErr === null;
    const ok = redisConfigured && redisOk && storageConfigured && storageOk;
    return jsonResponse(ok ? 200 : 503, {
      status: ok ? "ok" : "degraded",
      redis: { configured: redisConfigured, reachable: redisOk },
      storage: {
        configured: storageConfigured,
        reachable: storageOk,
        error: storageErr ?? undefined,
      },
    });
  }

  if (url.pathname === "/auth/challenge" && req.method === "POST") {
    if (!challengeLimiter.allow(clientIp)) {
      return jsonResponse(429, { error: "rate_limited" });
    }
    return await handleChallenge(req);
  }

  if (url.pathname === "/themes" && req.method === "POST") {
    const address = req.headers.get("x-agent-address")?.toLowerCase();
    const writeKey = address ?? clientIp;
    if (!writeLimiter.allow(writeKey)) {
      return jsonResponse(429, { error: "rate_limited" });
    }
    return await handleSaveTheme(req);
  }

  const themeMatch = url.pathname.match(THEME_PATH_RE);
  if (themeMatch) {
    const [, hash, suffix] = themeMatch;
    if (req.method === "GET") {
      if (!readLimiter.allow(clientIp)) {
        return jsonResponse(429, { error: "rate_limited" });
      }
      if (suffix === "meta") return await handleGetThemeMeta(hash);
      return await handleGetTheme(hash);
    }
    if (req.method === "DELETE" && !suffix) {
      const address = req.headers.get("x-agent-address")?.toLowerCase();
      const writeKey = address ?? clientIp;
      if (!writeLimiter.allow(writeKey)) {
        return jsonResponse(429, { error: "rate_limited" });
      }
      return await handleDeleteTheme(hash, req);
    }
    return jsonResponse(405, { error: "method_not_allowed" });
  }

  const userMatch = url.pathname.match(USER_THEMES_PATH_RE);
  if (userMatch && req.method === "GET") {
    if (!readLimiter.allow(clientIp)) {
      return jsonResponse(429, { error: "rate_limited" });
    }
    return await handleListOwnerThemes(userMatch[1], url);
  }

  return jsonResponse(404, { error: "not_found" });
}
