import { randomUUID } from 'node:crypto';
import {
  hashToken,
  issueAccessToken,
  newRefreshToken,
  REFRESH_TOKEN_TTL_SECONDS,
  type Actor,
} from './auth';
import { unauthenticated } from './errors';
import { mutate, nowIso } from './store';

/**
 * Sessions: issuing, rotating and revoking refresh tokens.
 *
 * Kept apart from `auth.ts` because that file is pure crypto with no storage, which is what
 * lets it be swapped for an OIDC provider without anything else moving.
 */

export interface IssuedSession {
  accessToken: string;
  accessExpiresIn: number;
  refreshToken: string;
  refreshExpiresAt: string;
}

/** Starts a family. One login, one family, however many rotations follow. */
export async function startSession(actor: Actor): Promise<IssuedSession> {
  const refresh = newRefreshToken();
  const familyId = randomUUID();

  await mutate((store) => {
    store.refresh_tokens.push({
      id: randomUUID(),
      token_hash: refresh.hash,
      user_id: actor.userId,
      tenant_id: actor.tenantId,
      family_id: familyId,
      issued_at: nowIso(),
      expires_at: refresh.expiresAt,
      revoked_at: null,
      used_at: null,
    });
    pruneExpired(store.refresh_tokens);
  });

  const access = issueAccessToken(actor);
  return {
    accessToken: access.token,
    accessExpiresIn: access.expiresIn,
    refreshToken: refresh.token,
    refreshExpiresAt: refresh.expiresAt,
  };
}

/**
 * Exchanges a refresh token for a new pair.
 *
 * Presenting one that has already been used means two parties hold it. There is no way to
 * tell the legitimate client from the thief, so the entire family is revoked.
 */
export async function rotateSession(presented: string): Promise<IssuedSession> {
  const presentedHash = hashToken(presented);

  const outcome = await mutate((store) => {
    const record = store.refresh_tokens.find((token) => token.token_hash === presentedHash);
    if (!record) return { error: 'That session is no longer valid. Sign in again.' } as const;

    if (record.used_at || record.revoked_at) {
      // Replay. Burn the family — including whichever of the two is honest.
      const at = nowIso();
      for (const token of store.refresh_tokens) {
        if (token.family_id === record.family_id && !token.revoked_at) token.revoked_at = at;
      }
      console.warn(
        `[auth] refresh token replay on family ${record.family_id}; every token in it is revoked`,
      );
      return { error: 'That session was already used. Sign in again.' } as const;
    }

    if (new Date(record.expires_at).getTime() < Date.now()) {
      record.revoked_at = nowIso();
      return { error: 'That session has expired. Sign in again.' } as const;
    }

    const user = store.users.find((candidate) => candidate.id === record.user_id);
    if (!user || user.status !== 'active') {
      return { error: 'That account can no longer sign in.' } as const;
    }

    const successor = newRefreshToken();
    record.used_at = nowIso();
    store.refresh_tokens.push({
      id: randomUUID(),
      token_hash: successor.hash,
      user_id: record.user_id,
      tenant_id: record.tenant_id,
      family_id: record.family_id,
      issued_at: nowIso(),
      expires_at: successor.expiresAt,
      revoked_at: null,
      used_at: null,
    });
    pruneExpired(store.refresh_tokens);

    return {
      actor: {
        userId: user.id,
        tenantId: user.tenant_id,
        email: user.email,
        displayName: user.display_name,
      } satisfies Actor,
      refreshToken: successor.token,
      refreshExpiresAt: successor.expiresAt,
    } as const;
  });

  if ('error' in outcome) throw unauthenticated(outcome.error);

  const access = issueAccessToken(outcome.actor);
  return {
    accessToken: access.token,
    accessExpiresIn: access.expiresIn,
    refreshToken: outcome.refreshToken,
    refreshExpiresAt: outcome.refreshExpiresAt,
  };
}

/** Signing out revokes the whole family, not just the token in hand. */
export async function endSession(presented: string | null): Promise<void> {
  if (!presented) return;
  const presentedHash = hashToken(presented);

  await mutate((store) => {
    const record = store.refresh_tokens.find((token) => token.token_hash === presentedHash);
    if (!record) return;
    const at = nowIso();
    for (const token of store.refresh_tokens) {
      if (token.family_id === record.family_id && !token.revoked_at) token.revoked_at = at;
    }
  });
}

/** Revokes every session a user has. For deactivation, and for "sign out everywhere". */
export async function endAllSessions(userId: string): Promise<number> {
  return mutate((store) => {
    const at = nowIso();
    let revoked = 0;
    for (const token of store.refresh_tokens) {
      if (token.user_id === userId && !token.revoked_at) {
        token.revoked_at = at;
        revoked++;
      }
    }
    return revoked;
  });
}

/**
 * Drops tokens that expired long enough ago to be useless as evidence. Replay detection
 * needs a used token to stay findable, so this keeps them for a full TTL past expiry
 * rather than deleting on expiry.
 */
function pruneExpired(tokens: { expires_at: string }[]): void {
  const cutoff = Date.now() - REFRESH_TOKEN_TTL_SECONDS * 1000;
  for (let index = tokens.length - 1; index >= 0; index--) {
    if (new Date(tokens[index]!.expires_at).getTime() < cutoff) tokens.splice(index, 1);
  }
}
