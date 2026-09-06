import { describe, expect, it } from 'vitest'
import { illegalReason, likelyWinnerScore, loserChips, winnerChips } from '../chips'
import type { ScoringRules } from '../rules'

const to11: ScoringRules = { bestOf: 3, pointsToWin: 11, winBy: 2, hardCap: null }
const to11cap15: ScoringRules = { bestOf: 3, pointsToWin: 11, winBy: 2, hardCap: 15 }
const to15: ScoringRules = { bestOf: 1, pointsToWin: 15, winBy: 2, hardCap: null }

describe('the pre-selected winner score', () => {
  it('is the target, and the target is always an offered chip', () => {
    for (const rules of [to11, to11cap15, to15]) {
      const pick = likelyWinnerScore(rules)
      expect(pick).toBe(rules.pointsToWin)
      // If the pre-selection were ever off the chip row, the screen would show
      // a selected number nobody could unselect.
      expect(winnerChips(rules).chips).toContain(pick)
      // And it has to leave the other side something to tap.
      expect(loserChips(rules, pick).length).toBeGreaterThan(0)
    }
  })
})

describe('soft validation behind “their score isn’t here”', () => {
  it('says nothing about a score the chips would have offered anyway', () => {
    for (const rules of [to11, to11cap15, to15]) {
      for (const w of winnerChips(rules).chips) {
        for (const l of loserChips(rules, w)) {
          expect(illegalReason(rules, w, l)).toBeNull()
        }
      }
    }
  })

  it('names the rule when the game could not have ended there', () => {
    expect(illegalReason(to11, 11, 10)).toContain('win by 2')
    expect(illegalReason(to11, 12, 3)).toContain('first to 11')
    expect(illegalReason(to11cap15, 12, 3)).toContain('cap at 15')
  })

  it('calls a tie a tie rather than reciting the rules at it', () => {
    expect(illegalReason(to11, 11, 11)).toBe('11–11 has nobody winning the game.')
    expect(illegalReason(to11, 9, 11)).toContain('nobody winning')
  })
})
