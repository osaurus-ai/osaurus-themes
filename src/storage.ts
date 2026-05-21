import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const BUCKET = Deno.env.get("BUCKET_NAME") ?? "";
const ENDPOINT = Deno.env.get("AWS_ENDPOINT_URL_S3");
const REGION = Deno.env.get("AWS_REGION") ?? "auto";
const ACCESS_KEY = Deno.env.get("AWS_ACCESS_KEY_ID");
const SECRET_KEY = Deno.env.get("AWS_SECRET_ACCESS_KEY");
// Tigris docs default to virtual-hosted style, but some endpoint setups need
// path-style. Opt in via env var if needed.
const FORCE_PATH_STYLE = Deno.env.get("S3_FORCE_PATH_STYLE") === "1";

function logStorageConfig(): void {
  console.log(
    `[storage] bucket=${BUCKET || "<unset>"} endpoint=${ENDPOINT ?? "<unset>"} ` +
      `region=${REGION} access_key=${ACCESS_KEY ? "set" : "<unset>"} ` +
      `secret_key=${SECRET_KEY ? "set" : "<unset>"} ` +
      `force_path_style=${FORCE_PATH_STYLE}`,
  );
  if (!BUCKET) console.warn("[storage] BUCKET_NAME is not set");
  if (!ENDPOINT) console.warn("[storage] AWS_ENDPOINT_URL_S3 is not set");
  if (!ACCESS_KEY) console.warn("[storage] AWS_ACCESS_KEY_ID is not set");
  if (!SECRET_KEY) console.warn("[storage] AWS_SECRET_ACCESS_KEY is not set");
}

logStorageConfig();

let s3: S3Client | null = null;

function client(): S3Client {
  if (!s3) {
    s3 = new S3Client({
      region: REGION,
      endpoint: ENDPOINT,
      forcePathStyle: FORCE_PATH_STYLE,
    });
  }
  return s3;
}

export interface StorageClient {
  isConfigured(): boolean;
  checkReachable(): Promise<string | null>;
  putTheme(hash: string, body: Uint8Array, contentType: string): Promise<void>;
  getThemeStream(hash: string): Promise<
    {
      body: ReadableStream<Uint8Array>;
      contentType: string;
      contentLength: number | null;
    } | null
  >;
  headTheme(hash: string): Promise<{ contentLength: number | null } | null>;
  deleteTheme(hash: string): Promise<void>;
}

function key(hash: string): string {
  return `themes/${hash}.json`;
}

function describeError(err: unknown): string {
  if (!err) return "<unknown>";
  if (err instanceof Error) {
    const e = err as Error & {
      name?: string;
      $metadata?: { httpStatusCode?: number; requestId?: string };
      Code?: string;
    };
    const code = e.name ?? e.Code ?? "Error";
    const status = e.$metadata?.httpStatusCode;
    const reqId = e.$metadata?.requestId;
    return `${code} status=${status ?? "?"} reqId=${reqId ?? "?"} message=${e.message}`;
  }
  return String(err);
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === "NoSuchKey" || e.name === "NotFound" ||
    e.$metadata?.httpStatusCode === 404;
}

class TigrisStorage implements StorageClient {
  isConfigured(): boolean {
    return Boolean(BUCKET && ENDPOINT && ACCESS_KEY && SECRET_KEY);
  }

  async checkReachable(): Promise<string | null> {
    if (!this.isConfigured()) return "not_configured";
    try {
      await client().send(new HeadBucketCommand({ Bucket: BUCKET }));
      return null;
    } catch (err) {
      return describeError(err);
    }
  }

  async putTheme(hash: string, body: Uint8Array, contentType: string): Promise<void> {
    try {
      await client().send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key(hash),
          Body: body,
          ContentType: contentType,
          CacheControl: "public, max-age=31536000, immutable",
        }),
      );
    } catch (err) {
      console.error(`[storage] putTheme(${hash}) failed: ${describeError(err)}`);
      throw err;
    }
  }

  async getThemeStream(hash: string): Promise<
    {
      body: ReadableStream<Uint8Array>;
      contentType: string;
      contentLength: number | null;
    } | null
  > {
    try {
      const out = await client().send(
        new GetObjectCommand({ Bucket: BUCKET, Key: key(hash) }),
      );
      if (!out.Body) return null;
      const stream = out.Body as unknown as ReadableStream<Uint8Array>;
      return {
        body: stream,
        contentType: out.ContentType ?? "application/json",
        contentLength: out.ContentLength ?? null,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      console.error(`[storage] getThemeStream(${hash}) failed: ${describeError(err)}`);
      throw err;
    }
  }

  async headTheme(hash: string): Promise<{ contentLength: number | null } | null> {
    try {
      const out = await client().send(
        new HeadObjectCommand({ Bucket: BUCKET, Key: key(hash) }),
      );
      return { contentLength: out.ContentLength ?? null };
    } catch (err) {
      if (isNotFound(err)) return null;
      console.error(`[storage] headTheme(${hash}) failed: ${describeError(err)}`);
      throw err;
    }
  }

  async deleteTheme(hash: string): Promise<void> {
    try {
      await client().send(
        new DeleteObjectCommand({ Bucket: BUCKET, Key: key(hash) }),
      );
    } catch (err) {
      console.error(`[storage] deleteTheme(${hash}) failed: ${describeError(err)}`);
      throw err;
    }
  }
}

let storage: StorageClient = new TigrisStorage();

export function getStorage(): StorageClient {
  return storage;
}

export function isStorageConfigured(): boolean {
  return storage.isConfigured();
}

export function checkBucketReachable(): Promise<string | null> {
  return storage.checkReachable();
}

export function _setStorageForTesting(s: StorageClient): void {
  storage = s;
}
