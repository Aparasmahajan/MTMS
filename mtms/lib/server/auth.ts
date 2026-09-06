import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Email and password only — no SSO in this release, and no self sign-up: accounts are
 * created by invitation and the invited user sets their own password from the emailed
 * link.
 *
 * Shaped so an OIDC provider can replace it without a route handler changing:
 * everything above depends on `verifyAccessToken` returning an `Actor` and on nothing
 * else. Passwords use scrypt and tokens a HMAC-SHA256 JWT, both from node:crypto, so
 * the app installs with no native build step.
 */

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const SCRYPT_KEY_LENGTH = 64;
export const ACCESS_COOKIE = 'tracker_at';
export const ACCESS_TOKEN_TTL_SECONDS = 12 * 60 * 60;
export const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

function secret(): string {
  const configured = process.env.JWT_SECRET;
  if (!configured && process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set in production');
  }
  return configured || 'mtms-development-secret-change-me-0123456789';
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, SCRYPT_KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, 'hex');
  const derived = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// ---------------------------------------------------------------------------
// Invitation tokens — single-use and expiring
// ---------------------------------------------------------------------------

export function newInviteToken(): { token: string; hash: string; expiresAt: string } {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    hash: hashToken(token),
    expiresAt: new Date(Date.now() + INVITE_TTL_SECONDS * 1000).toISOString(),
  };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ---------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------

/**
 * The tenant comes from the token claim and from nowhere else — not a query
 * parameter, not a header, not a body field.
 */
export interface Actor {
  userId: string;
  tenantId: string;
  email: string;
  displayName: string;
}

interface Claims extends Actor {
  exp: number;
  jti: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function issueAccessToken(actor: Actor): { token: string; expiresIn: number } {
  const claims: Claims = {
    ...actor,
    exp: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
    jti: randomUUID(),
  };
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(claims));
  const payload = `${header}.${body}`;
  return { token: `${payload}.${sign(payload)}`, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

/** Returns null rather than throwing — an expired cookie is an ordinary state. */
export function verifyAccessToken(token: string): Actor | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts as [string, string, string];

  const expected = sign(`${header}.${body}`);
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Claims;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null;
    if (!claims.userId || !claims.tenantId) return null;
    return {
      userId: claims.userId,
      tenantId: claims.tenantId,
      email: claims.email,
      displayName: claims.displayName,
    };
  } catch {
    return null;
  }
}
