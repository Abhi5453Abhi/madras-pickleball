'use server'

import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { recordAudit } from '@/lib/audit'
import { minutesOfDay, venueDayKey } from '@/lib/time'
import { createEvent, type Discipline, type FinalsStage, type Gender } from '@/server/events'


export type NewState = { error?: string }

const GENDERS: Gender[] = ['mens', 'womens', 'mixed', 'any']
const DISCIPLINES: Discipline[] = ['singles', 'doubles']
const FORMATS: FinalsStage[] = ['none', 'final_only', 'semis_and_final']

/**
 * The hours the courts are held for, or null for the whole day.
 *
 * Both blank is "all day", which is what a tournament held before it could
 * hold anything else; one blank is a half-finished thought and is refused
 * rather than guessed at.
 */
function readHours(formData: FormData): { fromMin: number; untilMin: number } | null | 'bad' {
  const from = String(formData.get('courtsFrom') ?? '').trim()
  const until = String(formData.get('courtsUntil') ?? '').trim()
  if (!from && !until) return null
  const fromMin = minutesOfDay(from)
  const untilMin = minutesOfDay(until)
  if (fromMin === null || untilMin === null || untilMin <= fromMin) return 'bad'
  return { fromMin, untilMin }
}

/** "2026-09-05" → 08:00 that morning at the venue, as an instant. */
function dateFromDayKey(key: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null
  const d = new Date(`${key}T08:00:00+05:30`)
  return Number.isNaN(d.getTime()) ? null : d
}

export async function createTournamentAction(_prev: NewState, formData: FormData): Promise<NewState> {
  const user = await requireUser('admin')

  const name = String(formData.get('name') ?? '').trim()
  const dayKey = String(formData.get('date') ?? '')
  const gender = String(formData.get('gender') ?? '') as Gender
  const discipline = String(formData.get('discipline') ?? '') as Discipline
  const finalsStage = String(formData.get('format') ?? '') as FinalsStage
  const courtIds = formData.getAll('courts').map(String).filter(Boolean)
  // `||`, not `??`: an emptied number input submits '', and Number('') is 0.
  const days = Number(formData.get('days') || 1)
  const hours = readHours(formData)
  if (hours === 'bad') return { error: 'Those court hours don’t read as a start and a finish.' }

  if (!name) return { error: 'Give it a name — you can change it later.' }
  const date = dateFromDayKey(dayKey)
  if (!date) return { error: 'Pick the day it is on.' }
  if (dayKey < venueDayKey(new Date())) return { error: 'That day has already gone.' }
  if (!GENDERS.includes(gender)) return { error: 'Pick a category.' }
  if (!DISCIPLINES.includes(discipline)) return { error: 'Singles or doubles?' }
  if (!FORMATS.includes(finalsStage)) return { error: 'Pick a format.' }

  if (!Number.isFinite(days) || days < 1 || days > 14) return { error: 'A tournament runs between one and fourteen days.' }
  const made = await createEvent({ name, date, gender, discipline, finalsStage, courtIds, hours, days })
  if (!made.courts.ok) {
    // The tournament exists and its courts do not — better than the reverse.
    // The hub says so and the courts screen fixes it.
    redirect(`/admin/t/${made.tournament.slug}?courts=${encodeURIComponent(made.courts.error)}` as never)
  }

  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'tournament.create',
    entity: 'tournament',
    entityId: made.tournament.id,
    after: { name, dayKey, days, gender, discipline, finalsStage, courts: courtIds.length },
  })

  redirect(`/admin/t/${made.tournament.slug}`)
}
