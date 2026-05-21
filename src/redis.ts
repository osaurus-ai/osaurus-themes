import { Redis } from "ioredis";

const NONCE_TTL_SECONDS = 60;

const REDIS_URL = Deno.env.get("REDIS_URL");

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "<unparseable>";
  }
}

let client: Redis | null = null;

if (REDIS_URL) {
  console.log(`[redis] connecting to ${redactUrl(REDIS_URL)}`);
  client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    connectTimeout: 10_000,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  client.on("connect", () => console.log("[redis] connect"));
  client.on("ready", () => console.log("[redis] ready"));
  client.on("error", (err) => console.error("[redis] error:", err?.message ?? err));
  client.on("end", () => console.warn("[redis] connection ended"));
  client.on("reconnecting", (ms: number) => console.warn(`[redis] reconnecting in ${ms}ms`));
} else {
  console.warn("[redis] REDIS_URL is not set — all storage ops will fail");
}

// deno-lint-ignore no-explicit-any
export function _setClientForTesting(c: any): void {
  client = c;
}

function requireClient(): Redis {
  if (!client) throw new Error("redis_not_configured");
  return client;
}

export function isRedisConfigured(): boolean {
  return client !== null;
}

export async function pingRedis(): Promise<boolean> {
  if (!client) return false;
  try {
    const reply = await client.ping();
    return reply === "PONG";
  } catch {
    return false;
  }
}

function nonceKey(nonce: string): string {
  return `nonce:${nonce}`;
}

function themeKey(hash: string): string {
  return `theme:${hash}`;
}

function ownerIndexKey(address: string): string {
  return `themes_by_owner:${address}`;
}

// --- Nonces -----------------------------------------------------------------

/**
 * Issue a single-use nonce bound to `address`. The nonce expires automatically
 * after NONCE_TTL_SECONDS if unused.
 */
export async function issueNonce(address: string, nonce: string): Promise<void> {
  await requireClient().set(nonceKey(nonce), address, "EX", NONCE_TTL_SECONDS);
}

/**
 * Atomically consume a nonce and return the address it was issued to, or null
 * if it never existed or has already been consumed/expired.
 */
export async function consumeNonce(nonce: string): Promise<string | null> {
  const c = requireClient();
  // GETDEL is atomic in Redis 6.2+ (Upstash supports it).
  // deno-lint-ignore no-explicit-any
  return (await (c as any).getdel(nonceKey(nonce))) ?? null;
}

// --- Theme metadata ---------------------------------------------------------

export interface ThemeMeta {
  owner: string;
  created_at: number;
  size: number;
  content_type: string;
}

export async function saveThemeMeta(hash: string, meta: ThemeMeta): Promise<void> {
  const c = requireClient();
  await c.hset(themeKey(hash), {
    owner: meta.owner,
    created_at: String(meta.created_at),
    size: String(meta.size),
    content_type: meta.content_type,
  });
}

export async function getThemeMeta(hash: string): Promise<ThemeMeta | null> {
  const c = requireClient();
  const raw = (await c.hgetall(themeKey(hash))) as Record<string, string>;
  if (!raw || !raw.owner) return null;
  return {
    owner: raw.owner,
    created_at: Number(raw.created_at) || 0,
    size: Number(raw.size) || 0,
    content_type: raw.content_type ?? "application/json",
  };
}

export async function deleteThemeMeta(hash: string): Promise<void> {
  await requireClient().del(themeKey(hash));
}

// --- Owner index ------------------------------------------------------------

export async function addOwnerIndex(
  address: string,
  hash: string,
  createdAt: number,
): Promise<void> {
  await requireClient().zadd(ownerIndexKey(address), createdAt, hash);
}

export async function removeOwnerIndex(address: string, hash: string): Promise<void> {
  await requireClient().zrem(ownerIndexKey(address), hash);
}

/**
 * List an owner's theme hashes, newest first.
 */
export async function listOwnerThemes(
  address: string,
  offset = 0,
  limit = 50,
): Promise<string[]> {
  const c = requireClient();
  return await c.zrevrange(ownerIndexKey(address), offset, offset + limit - 1);
}

/**
 * Total count of themes owned by an address.
 */
export async function countOwnerThemes(address: string): Promise<number> {
  return await requireClient().zcard(ownerIndexKey(address));
}

/**
 * Gracefully close the Redis connection (used on SIGTERM).
 */
export async function closeRedis(): Promise<void> {
  if (!client) return;
  try {
    await client.quit();
  } catch {
    // already closed
  }
}
