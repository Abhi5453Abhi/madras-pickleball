import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { db } from '@/db'
import { gameSessions, tournaments } from '@/db/schema'

/**
 * One monotonic counter per tournament, bumped in the same transaction as any
 * board-visible write. Clients poll this integer and fetch the payload only when
 * it moves — max(updated_at) is a multi-table fan-out that also freezes silently
 * on soft deletes and same-millisecond writes (SPEC A9).
 */
export async function bumpStreamVersion(
  tournamentId: string,
  tx: { update: typeof db.update } = db,
) {
  await tx
    .update(tournaments)
    .set({ streamVersion: sql`${tournaments.streamVersion} + 1`, updatedAt: new Date() })
    .where(eq(tournaments.id, tournamentId))
}

export async function readStreamVersion(tournamentSlug: string) {
  const rows = await db
    .select({ v: tournaments.streamVersion, id: tournaments.id })
    .from(tournaments)
    .where(eq(tournaments.slug, tournamentSlug))
    .limit(1)
  return rows[0] ?? null
}

/**
 * The same counter, for a daily game. Bumped in the same transaction as any
 * write the public list or the host's screen can see, so a phone polling the
 * version route refreshes exactly when something changed and never otherwise.
 */
export async function bumpSessionVersion(sessionId: string, tx: { update: typeof db.update } = db) {
  await tx
    .update(gameSessions)
    .set({ streamVersion: sql`${gameSessions.streamVersion} + 1`, updatedAt: new Date() })
    .where(eq(gameSessions.id, sessionId))
}
