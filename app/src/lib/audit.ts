import 'server-only'
import { db } from '@/db'
import { auditLog } from '@/db/schema'
import { newId } from './ids'

type AuditInput = {
  userId?: string | null
  actorLabel: string
  action: string
  entity: string
  entityId: string
  reason?: string | null
  before?: unknown
  after?: unknown
}

/** Every correction and every destructive action leaves a row (SPEC A7). */
export async function recordAudit(input: AuditInput, tx: { insert: typeof db.insert } = db) {
  await tx.insert(auditLog).values({
    id: newId('aud'),
    userId: input.userId ?? null,
    actorLabel: input.actorLabel,
    action: input.action,
    entity: input.entity,
    entityId: input.entityId,
    reason: input.reason ?? null,
    before: (input.before ?? null) as never,
    after: (input.after ?? null) as never,
  })
}
