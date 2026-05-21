import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const BUCKET = Deno.env.get("BUCKET_NAME") ?? "";
const ENDPOINT = Deno.env.get("AWS_ENDPOINT_URL_S3");
const REGION = Deno.env.get("AWS_REGION") ?? "auto";

let s3: S3Client | null = null;

function client(): S3Client {
  if (!s3) {
    s3 = new S3Client({
      region: REGION,
      endpoint: ENDPOINT,
      // Tigris is path-style friendly; AWS SDK v3 defaults to virtual-hosted
      // style which Tigris also supports, but force path-style for stability
      // against custom endpoints and DNS quirks.
      forcePathStyle: true,
    });
  }
  return s3;
}

export interface StorageClient {
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

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === "NoSuchKey" || e.name === "NotFound" ||
    e.$metadata?.httpStatusCode === 404;
}

class TigrisStorage implements StorageClient {
  async putTheme(hash: string, body: Uint8Array, contentType: string): Promise<void> {
    await client().send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key(hash),
        Body: body,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
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
      throw err;
    }
  }

  async deleteTheme(hash: string): Promise<void> {
    await client().send(
      new DeleteObjectCommand({ Bucket: BUCKET, Key: key(hash) }),
    );
  }
}

let storage: StorageClient = new TigrisStorage();

export function getStorage(): StorageClient {
  return storage;
}

export function _setStorageForTesting(s: StorageClient): void {
  storage = s;
}
