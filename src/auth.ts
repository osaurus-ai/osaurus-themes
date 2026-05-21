import { verifyMessage } from "viem";

const TIMESTAMP_WINDOW_SECONDS = 30;

export function generateNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function buildWriteMessage(
  address: string,
  bodyHash: string,
  nonce: string,
  timestamp: number,
): string {
  return `osaurus-theme:${address}:${bodyHash}:${nonce}:${timestamp}`;
}

export function buildDeleteMessage(
  address: string,
  hash: string,
  nonce: string,
  timestamp: number,
): string {
  return `osaurus-theme-delete:${address}:${hash}:${nonce}:${timestamp}`;
}

export function isTimestampValid(timestamp: number, nowSeconds?: number): boolean {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  return Math.abs(now - timestamp) <= TIMESTAMP_WINDOW_SECONDS;
}

/**
 * Verifies an EIP-191 personal_sign signature over `message` was produced by
 * the secp256k1 key corresponding to `address`. Returns the lower-cased address
 * on success, or null on any verification failure.
 */
export async function verifySignature(
  address: string,
  message: string,
  signature: string,
): Promise<string | null> {
  try {
    const valid = await verifyMessage({
      address: address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
    if (!valid) return null;
  } catch {
    return null;
  }
  return address.toLowerCase();
}
