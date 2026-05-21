# Osaurus Themes

A Deno HTTP API for publishing custom [Osaurus](https://github.com/osaurus-ai/osaurus) themes. Users
sign each upload with their secp256k1 identity (the same one used by the relay). The server stores
the payload in Fly's Tigris object storage, addresses it by SHA-256 content hash, and serves it
publicly at a stable URL so it can be installed by anyone with the hash.

```
[Osaurus client] -- POST /auth/challenge -> [themes API]            (nonce)
[Osaurus client] -- POST /themes signed -> [themes API] -> [Tigris] (blob)
                                                  |
                                                  +--> [Upstash Redis] (metadata + owner index)

[Anyone] -- GET /themes/<hash> -------> [themes API] -> [Tigris]    (raw JSON)
```

## Requirements

- [Deno](https://deno.land/) v2+
- A Fly.io app with a Tigris bucket and an Upstash Redis instance

## Quick start

```bash
deno install            # install npm deps
deno task dev           # run locally with file watcher
deno task test          # run the test suite
deno task lint
deno task fmt
```

The server listens on port `8080` by default. Override with `PORT`.

## Project structure

```
osaurus-themes/
├── main.ts              # Deno.serve entry point
├── src/
│   ├── router.ts        # HTTP routing + per-endpoint rate limits
│   ├── themes.ts        # save / get / meta / list / delete handlers + SHA-256 hashing
│   ├── auth.ts          # secp256k1 signature verify (viem) + EIP-191 message format
│   ├── storage.ts       # S3 client pointed at Tigris (put / get-stream / head / delete)
│   ├── redis.ts         # nonces (GETDEL), theme metadata (HSET), owner index (ZADD)
│   ├── rate_limit.ts    # in-memory token bucket
│   ├── http.ts          # jsonResponse, readBodyBytes, CORS
│   └── types.ts         # request / response types
└── test/                # auth, redis, rate_limit, themes, mocks
```

## Configuration

All configured via environment variables (use Fly secrets in production):

| Variable                | Required | Description                                                                                                                |
| ----------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                  | no       | HTTP listen port. Default `8080`.                                                                                          |
| `BASE_URL`              | no       | Public base URL used in returned `url` fields, e.g. `https://themes.osaurus.ai`. Derived from the request `Host` if unset. |
| `REDIS_URL`             | yes      | Upstash Redis connection string (`rediss://...`).                                                                          |
| `BUCKET_NAME`           | yes      | Tigris bucket name.                                                                                                        |
| `AWS_ENDPOINT_URL_S3`   | yes      | Tigris S3 endpoint, e.g. `https://fly.storage.tigris.dev`.                                                                 |
| `AWS_ACCESS_KEY_ID`     | yes      | Tigris access key.                                                                                                         |
| `AWS_SECRET_ACCESS_KEY` | yes      | Tigris secret key.                                                                                                         |
| `AWS_REGION`            | no       | Tigris region (defaults to `auto`).                                                                                        |

## Endpoints

### `GET /health`

Liveness check. Returns `{ "status": "ok" }`.

### `POST /auth/challenge`

Issues a single-use nonce bound to the caller's address. Required as the first step before
`POST /themes` or `DELETE /themes/:hash`.

Request:

```json
{ "address": "0xYourAddress..." }
```

Response (200):

```json
{ "nonce": "<64 hex chars>", "expires_in": 60 }
```

Rate-limited to 30/min per IP. The nonce expires after 60 seconds if unused and is consumed
atomically on first use.

### `POST /themes`

Save a theme. The body is the raw theme JSON (up to 5 MB). The server hashes the bytes with SHA-256
and uses the hex digest as the public identifier.

Headers:

| Header            | Value                                                                |
| ----------------- | -------------------------------------------------------------------- |
| `X-Agent-Address` | The lowercase `0x`-prefixed secp256k1 address that issued the nonce. |
| `X-Nonce`         | The 64-char hex nonce returned by `/auth/challenge`.                 |
| `X-Timestamp`     | Unix seconds. Must be within ±30s of the server clock.               |
| `X-Signature`     | EIP-191 `personal_sign` over the message below.                      |

Signed message:

```
osaurus-theme:<address>:<sha256(body)>:<nonce>:<timestamp>
```

Including the body hash in the signed message binds the signature to the exact payload — a stolen
header set cannot be replayed against a different theme.

Response (200):

```json
{
  "hash": "<sha256 hex>",
  "url": "https://themes.osaurus.ai/themes/<sha256>"
}
```

Identical payloads dedupe automatically (content addressing), so re-uploading the same theme is
cheap and returns the same hash.

### `GET /themes/:hash`

Public, unauthenticated. Streams the raw theme JSON with long-lived immutable cache headers. Returns
`404` if missing.

### `GET /themes/:hash/meta`

Public. Returns the theme's owner and creation metadata:

```json
{ "owner": "0x...", "created_at": 1709136000, "size": 4242 }
```

### `GET /users/:address/themes`

Public. Lists an owner's theme hashes, newest first. Pagination via `?offset=N&limit=M` (limit max
200).

```json
{
  "address": "0x...",
  "hashes": ["<sha256>", "<sha256>", "..."],
  "next_offset": 50
}
```

### `DELETE /themes/:hash`

Owner-only. Same signed-headers scheme as `POST /themes`, but the signed message is:

```
osaurus-theme-delete:<address>:<hash>:<nonce>:<timestamp>
```

Returns `200 { "ok": true }`, or `403` if the signing address doesn't own the theme.

## Error codes

| Status | `error` value                   | Meaning                                                                         |
| ------ | ------------------------------- | ------------------------------------------------------------------------------- |
| 400    | `invalid_json`                  | Body is not valid JSON                                                          |
| 400    | `invalid_address`               | Address is not `0x` + 40 hex chars                                              |
| 400    | `invalid_hash`                  | Hash is not 64 hex chars                                                        |
| 400    | `empty_body`                    | `POST /themes` body was empty                                                   |
| 400    | `theme_must_be_object`          | Theme JSON must be an object (not array/primitive)                              |
| 401    | `missing_auth_headers`          | One of `X-Agent-Address`/`X-Nonce`/`X-Timestamp`/`X-Signature` was missing      |
| 401    | `timestamp_out_of_window`       | Client clock more than 30s off                                                  |
| 401    | `invalid_nonce`                 | Nonce never issued, already consumed, expired, or issued to a different address |
| 401    | `signature_verification_failed` | EIP-191 signature didn't recover the claimed address                            |
| 403    | `forbidden`                     | Signing address is not the theme's owner                                        |
| 404    | `not_found`                     | Theme hash unknown                                                              |
| 413    | `body_too_large`                | Body exceeded 5 MB (streamed early-abort)                                       |
| 429    | `rate_limited`                  | Per-endpoint rate limit hit                                                     |
| 502    | `storage_write_failed`          | Tigris PUT failed                                                               |
| 502    | `storage_read_failed`           | Tigris GET failed                                                               |
| 502    | `storage_delete_failed`         | Tigris DELETE failed                                                            |
| 503    | `storage_unavailable`           | Redis nonce write/read failed                                                   |
| 503    | `metadata_write_failed`         | Redis metadata write failed after a successful upload                           |
| 503    | `metadata_read_failed`          | Redis metadata read failed                                                      |

## Rate limits

| Scope                                                         | Limit                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------- |
| `POST /auth/challenge`                                        | 30/min per IP                                           |
| `POST /themes`, `DELETE`                                      | 10/min per address (falls back to IP if header missing) |
| `GET /themes/:hash` and `/meta`, `GET /users/:address/themes` | 300/min per IP                                          |
| Request body size                                             | 5 MB (streamed read with early abort)                   |

## Client example (TypeScript, viem)

```ts
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(MY_PRIVATE_KEY);
const address = account.address.toLowerCase();
const base = "https://themes.osaurus.ai";

// 1. Get a nonce.
const { nonce } = await (await fetch(`${base}/auth/challenge`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ address }),
})).json();

// 2. Build + hash the body, sign, upload.
const body = new TextEncoder().encode(JSON.stringify({
  name: "Midnight",
  colors: { background: "#0b0f1a", foreground: "#e6e9ef" },
  // ...possibly a base64-encoded image up to ~3 MB...
}));
const digest = await crypto.subtle.digest("SHA-256", body);
const bodyHash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(
  "",
);
const timestamp = Math.floor(Date.now() / 1000);
const signature = await account.signMessage({
  message: `osaurus-theme:${address}:${bodyHash}:${nonce}:${timestamp}`,
});

const saved = await (await fetch(`${base}/themes`, {
  method: "POST",
  headers: {
    "x-agent-address": address,
    "x-nonce": nonce,
    "x-timestamp": String(timestamp),
    "x-signature": signature,
    "content-type": "application/json",
  },
  body,
})).json();

console.log("Install URL:", saved.url);
```

Anyone can then install the theme by fetching `GET <saved.url>` — no auth required.

## Security model

- **EIP-191 signatures** — Every write/delete is signed by the owner's secp256k1 key. The signed
  message includes the SHA-256 of the body (for writes) or the target hash (for deletes), so
  intercepted headers cannot be reused against a different payload.
- **Single-use nonces** — Each nonce is issued to a specific address with a 60s TTL and consumed
  atomically (`GETDEL`). Replays are impossible after the first use.
- **Bounded timestamp window** — Client clock must be within ±30s of the server. Combined with the
  short nonce TTL this leaves no useful replay window.
- **Streamed body cap** — Requests larger than 5 MB are aborted mid-read so an attacker can't
  exhaust memory by omitting `content-length`.
- **Owner-only mutation** — `DELETE /themes/:hash` checks that the signing address matches the
  stored `owner` field. Otherwise the operation returns `403`.
- **Public reads** — `GET /themes/:hash` and `/meta` are intentionally unauthenticated so install
  URLs work for anyone with the hash. Don't put secrets in theme payloads.

## Deploy to Fly.io

```bash
# 1. App + region.
fly launch --no-deploy

# 2. Tigris object storage (sets BUCKET_NAME, AWS_* secrets).
fly storage create

# 3. Upstash Redis (sets REDIS_URL).
fly redis create

# 4. Optionally set BASE_URL.
fly secrets set BASE_URL=https://themes.osaurus.ai

# 5. Deploy.
fly deploy
```

DNS:

```
themes.osaurus.ai.  A     <fly.io IP>
themes.osaurus.ai.  AAAA  <fly.io IPv6>
```

Fly terminates TLS automatically.

## License

MIT
