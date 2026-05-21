import { handleRequest } from "./src/router.ts";
import { closeRedis, isRedisConfigured } from "./src/redis.ts";
import { isStorageConfigured } from "./src/storage.ts";

const PORT = parseInt(Deno.env.get("PORT") ?? "8080");
const STRICT_ENV = Deno.env.get("STRICT_ENV") === "1";

function validateEnv(): void {
  const issues: string[] = [];
  if (!isRedisConfigured()) issues.push("REDIS_URL is not set");
  if (!isStorageConfigured()) {
    issues.push(
      "Tigris S3 vars are not all set (BUCKET_NAME, AWS_ENDPOINT_URL_S3, " +
        "AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)",
    );
  }
  if (!Deno.env.get("BASE_URL")) {
    issues.push(
      "BASE_URL is not set; install URLs will be derived from the Host header",
    );
  }
  if (issues.length === 0) {
    console.log("[startup] env OK");
    return;
  }
  for (const issue of issues) console.warn(`[startup] ${issue}`);
  if (STRICT_ENV) {
    console.error("[startup] STRICT_ENV=1 — exiting due to env issues");
    Deno.exit(1);
  }
}

validateEnv();

const server = Deno.serve({ port: PORT }, handleRequest);

async function shutdown(sig: string): Promise<void> {
  console.log(`[shutdown] received ${sig}, draining connections`);
  try {
    await server.shutdown();
  } catch (err) {
    console.error("[shutdown] server.shutdown failed:", err);
  }
  await closeRedis();
  console.log("[shutdown] complete");
  Deno.exit(0);
}

Deno.addSignalListener("SIGTERM", () => void shutdown("SIGTERM"));
Deno.addSignalListener("SIGINT", () => void shutdown("SIGINT"));
