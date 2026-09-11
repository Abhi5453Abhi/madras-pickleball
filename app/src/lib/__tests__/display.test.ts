import { describe, expect, it } from 'vitest'
import { paiseFromRupeeInput, publicName, rupees, rupeesPlain, spotsLabel } from '../display'

describe('publicName', () => {
  it('is a first name and a last initial', () => {
    expect(publicName('Ravi Shankar')).toBe('Ravi S.')
    expect(publicName('Deepak Raj')).toBe('Deepak R.')
  })

  it('leaves a single name alone', () => {
    expect(publicName('Suresh')).toBe('Suresh')
  })

  it('takes the initial from the last name, not the middle one', () => {
    expect(publicName('Hari Venkatesh Iyer')).toBe('Hari I.')
  })

  it('does not correct anybody’s capitalisation, only the initial', () => {
    expect(publicName('ravi kumar')).toBe('ravi K.')
  })

  it('copes with extra spaces, an empty string and a non-Latin initial', () => {
    expect(publicName('  Ravi   Kumar  ')).toBe('Ravi K.')
    expect(publicName('   ')).toBe('Someone')
    expect(publicName('')).toBe('Someone')
    expect(publicName('ரவி குமார்')).toBe('ரவி க.')
  })

  it('never leaks a full surname, which is the whole point of it', () => {
    expect(publicName('Ravi Shankar')).not.toContain('Shankar')
  })
})

describe('rupees', () => {
  it('drops the paise when there are none', () => {
    expect(rupees(30000)).toBe('₹300')
    expect(rupees(0)).toBe('₹0')
  })

  it('shows them when there are', () => {
    expect(rupees(30050)).toBe('₹300.50')
  })

  it('groups the Indian way', () => {
    expect(rupees(10000000)).toBe('₹1,00,000')
  })

  it('has a minus sign a credit can use', () => {
    expect(rupees(-30000)).toBe('−₹300')
  })

  it('has a plain form for a column that already says rupees', () => {
    expect(rupeesPlain(30000)).toBe('300')
    expect(rupeesPlain(30050)).toBe('300.50')
  })
})

describe('paiseFromRupeeInput', () => {
  it('reads what a person types', () => {
    expect(paiseFromRupeeInput('300')).toBe(30000)
    expect(paiseFromRupeeInput(' ₹300 ')).toBe(30000)
    expect(paiseFromRupeeInput('300.5')).toBe(30050)
    expect(paiseFromRupeeInput('300.50')).toBe(30050)
    expect(paiseFromRupeeInput('1,200')).toBe(120000)
    expect(paiseFromRupeeInput('')).toBe(0)
  })

  it('refuses anything that is not money rather than guessing', () => {
    expect(paiseFromRupeeInput('free')).toBe(null)
    expect(paiseFromRupeeInput('-300')).toBe(null)
    expect(paiseFromRupeeInput('300.555')).toBe(null)
    expect(paiseFromRupeeInput('3e2')).toBe(null)
  })

  it('always comes back as a whole number of paise — no float ever reaches the database', () => {
    for (const raw of ['0.01', '0.1', '1.99', '12345.67']) {
      const p = paiseFromRupeeInput(raw)
      expect(Number.isInteger(p)).toBe(true)
    }
    expect(paiseFromRupeeInput('0.07')).toBe(7)
    expect(paiseFromRupeeInput('1.10')).toBe(110)
  })
})

describe('spotsLabel', () => {
  it('is the count the whole page is about', () => {
    expect(spotsLabel(12, 16)).toBe('12/16')
  })
})
