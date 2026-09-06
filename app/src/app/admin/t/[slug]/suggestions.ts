/**
 * Which match to offer each free court.
 *
 * The rule itself lives in `@/server/board` now, because the auto-flow places
 * by it: the flow, the venue board's "Next here" line and the More page's
 * attention block all read the same function, so they can never disagree
 * about which pair is next. This file stays so the More page's import keeps
 * working.
 */
export { offersForFreeCourts } from '@/server/board'
