/**
 * What came back from the last tap, as a CODE rather than a sentence.
 *
 * This page is reached from links forwarded through WhatsApp, and a query
 * parameter that renders verbatim into a bordered notice is a message box
 * anybody can put words into. The page owns the words; the query string only
 * names which of them.
 *
 * Kept out of `actions.ts` because that file is `'use server'`, where every
 * export has to be an async server action — a type guard is neither, and Next
 * refuses the build rather than the request, which is the right end to find out.
 */
export type SpotOutcome =
  | 'confirmed'
  | 'released'
  | 'released-promoted'
  | 'gone'
  | 'over'
  | 'started'
  | 'nothing'

const CODES = new Set<SpotOutcome>([
  'confirmed',
  'released',
  'released-promoted',
  'gone',
  'over',
  'started',
  'nothing',
])

export function isSpotOutcome(v: unknown): v is SpotOutcome {
  return typeof v === 'string' && CODES.has(v as SpotOutcome)
}
