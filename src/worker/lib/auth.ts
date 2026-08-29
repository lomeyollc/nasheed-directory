/**
 * Bearer API-key auth, shared by the REST and MCP surfaces.
 *
 * Plaintext keys are never stored. `api_tokens.token_hash` holds the
 * lowercase-hex SHA-256 of the key, produced by `hashToken` below — the same
 * function key issuance uses. Both sides must hash identically or a valid key
 * looks invalid.
 */

export interface AuthedKey {
  id: string;
  name: string | null;
  scope: "read" | "admin";
}

const KEY_PREFIX = "nsd_";

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generates a fresh plaintext key: a UUID's 16 raw bytes plus 24 more from
 * `crypto.getRandomValues` (margin against any weakness in one generator),
 * base64url-encoded and prefixed `nsd_` so keys are recognisable in logs
 * without decoding them. This is the only place the plaintext exists outside
 * the response that returns it exactly once.
 */
export function generateApiKey(): string {
  const uuidBytes = Uint8Array.from(
    (crypto.randomUUID().replace(/-/g, "").match(/../g) ?? []).map((h) => parseInt(h, 16))
  );
  const extra = crypto.getRandomValues(new Uint8Array(24));
  const combined = new Uint8Array(uuidBytes.length + extra.length);
  combined.set(uuidBytes, 0);
  combined.set(extra, uuidBytes.length);
  return `${KEY_PREFIX}${base64url(combined)}`;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Accepts the key from `Authorization: Bearer <key>` or, because a great many
 * HTTP clients and no-code tools make a custom header easier than an auth
 * header, from `X-API-Key`. Returns null for missing, malformed, unknown, or
 * revoked keys — the caller must not distinguish these in its response.
 */
export async function authenticate(request: Request, db: D1Database): Promise<AuthedKey | null> {
  const header = request.headers.get("Authorization");
  const key = header?.startsWith("Bearer ")
    ? header.slice("Bearer ".length).trim()
    : (request.headers.get("X-API-Key") ?? "").trim();

  if (!key) {
    return null;
  }

  const row = await db
    .prepare(
      "SELECT id, name, scope FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1"
    )
    .bind(await hashToken(key))
    .first<{ id: string; name: string | null; scope: "read" | "admin" }>();

  if (!row) {
    return null;
  }

  // Courtesy telemetry for the keys page. Never fail a request over it.
  db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), row.id)
    .run()
    .catch(() => {});

  return row;
}

export function unauthorized(message = "Missing or invalid API key"): Response {
  return json({ error: message, docs: "https://nasheed.lomeyo.com/docs" }, 401, {
    "WWW-Authenticate": 'Bearer realm="nasheed-directory"',
  });
}

export function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // The catalog is meant to be read from anywhere, including a browser
      // tool that has no server of its own. Nothing here is user-specific and
      // no cookie is ever read on these routes, so a wildcard is safe.
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });
}
