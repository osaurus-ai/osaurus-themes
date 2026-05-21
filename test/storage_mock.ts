import type { StorageClient } from "../src/storage.ts";

interface StoredBlob {
  bytes: Uint8Array;
  contentType: string;
}

export class MockStorage implements StorageClient {
  readonly blobs = new Map<string, StoredBlob>();
  putCalls = 0;
  deleteCalls = 0;
  headCalls = 0;
  getCalls = 0;

  putTheme(hash: string, body: Uint8Array, contentType: string): Promise<void> {
    this.putCalls++;
    this.blobs.set(hash, { bytes: body, contentType });
    return Promise.resolve();
  }

  getThemeStream(hash: string): Promise<
    {
      body: ReadableStream<Uint8Array>;
      contentType: string;
      contentLength: number | null;
    } | null
  > {
    this.getCalls++;
    const blob = this.blobs.get(hash);
    if (!blob) return Promise.resolve(null);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(blob.bytes);
        controller.close();
      },
    });
    return Promise.resolve({
      body: stream,
      contentType: blob.contentType,
      contentLength: blob.bytes.byteLength,
    });
  }

  headTheme(hash: string): Promise<{ contentLength: number | null } | null> {
    this.headCalls++;
    const blob = this.blobs.get(hash);
    if (!blob) return Promise.resolve(null);
    return Promise.resolve({ contentLength: blob.bytes.byteLength });
  }

  deleteTheme(hash: string): Promise<void> {
    this.deleteCalls++;
    this.blobs.delete(hash);
    return Promise.resolve();
  }
}
