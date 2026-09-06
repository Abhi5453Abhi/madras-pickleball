import { describe, it, expect } from 'vitest'
import {
  parsePlayerList,
  normalizeName,
  normalizePhone,
  findDuplicates,
  looksLikeSamePerson,
} from '../parse-players'

describe('parsing a WhatsApp list', () => {
  it('strips numbering, bullets, emoji and paid markers', () => {
    const rows = parsePlayerList(`1. Ravi Kumar ✅
2) Priya S 9840012345
- Karthik
• Meera Nair (paid)
   
4. Arun / Deepa`)
    expect(rows.map((r) => r.name)).toEqual([
      'Ravi Kumar',
      'Priya S',
      'Karthik',
      'Meera Nair',
      'Arun / Deepa',
    ])
  })

  it('pulls out a phone number and normalises it', () => {
    const [row] = parsePlayerList('Priya S 9840012345')
    expect(row.name).toBe('Priya S')
    expect(row.phone).toBe('+919840012345')
  })

  it('accepts +91 and 0 prefixes', () => {
    expect(parsePlayerList('Ravi +91 98400 12345')[0].phone).toBe('+919840012345')
    expect(parsePlayerList('Ravi 09840012345')[0].phone).toBe('+919840012345')
  })

  it('flags a line that looks like a pair rather than dropping it', () => {
    const [row] = parsePlayerList('Arun / Deepa')
    expect(row.warning).toMatch(/pair/)
    expect(row.name).toBe('Arun / Deepa')
  })

  it('never throws away a line it cannot read', () => {
    const rows = parsePlayerList('9840012345')
    expect(rows).toHaveLength(1)
    expect(rows[0].warning).toBe('No name on this line')
    expect(rows[0].phone).toBe('+919840012345')
  })

  it('ignores blank lines', () => {
    expect(parsePlayerList('\n\n  \nRavi\n\n')).toHaveLength(1)
  })
})

describe('normalising', () => {
  it('makes a comparable name key', () => {
    expect(normalizeName('Ravi  Kumar!')).toBe('ravi kumar')
    expect(normalizeName('RAVI KUMAR')).toBe(normalizeName('ravi kumar'))
  })

  it('rejects things that are not Indian mobiles', () => {
    expect(normalizePhone('12345')).toBeNull()
    expect(normalizePhone('1234567890')).toBeNull() // starts with 1
    expect(normalizePhone('9840012345')).toBe('+919840012345')
  })
})

describe('duplicate detection', () => {
  const roster = [
    { id: 'p1', name: 'Ravi Kumar', nameKey: 'ravi kumar', phoneKey: '+919840012345' },
    { id: 'p2', name: 'Meera Nair', nameKey: 'meera nair', phoneKey: null },
  ]

  it('matches on phone first', () => {
    const rows = parsePlayerList('Ravi K 9840012345')
    const dupes = findDuplicates(rows, roster)
    expect(dupes.get(0)).toEqual({ id: 'p1', name: 'Ravi Kumar', on: 'phone' })
  })

  it('falls back to a normalised name', () => {
    const rows = parsePlayerList('meera nair')
    expect(findDuplicates(rows, roster).get(0)).toEqual({
      id: 'p2',
      name: 'Meera Nair',
      on: 'name',
    })
  })

  it('leaves genuinely new people alone', () => {
    expect(findDuplicates(parsePlayerList('Anjali R'), roster).size).toBe(0)
  })
})

describe('the same person, typed differently', () => {
  const same = (a: string, b: string) => looksLikeSamePerson(normalizeName(a), normalizeName(b))

  it('spots an initial, a first name alone, and the words the other way round', () => {
    expect(same('Ravi S', 'Ravi Shankar')).toBe(true)
    expect(same('Ravi', 'Ravi Shankar')).toBe(true)
    expect(same('S Ravi', 'Ravi Shankar')).toBe(true)
    expect(same('R. Shankar', 'Ravi Shankar')).toBe(true)
    expect(same('Ravi Shankar', 'ravi   shankar')).toBe(true)
  })

  it('leaves two people who share a first name alone', () => {
    expect(same('Ravi Kumar', 'Ravi Shankar')).toBe(false)
    expect(same('Arun Prakash', 'Arun Kumar')).toBe(false)
    expect(same('Karthik', 'Sathish Kumar')).toBe(false)
  })

  it('does not let a pair of initials match everybody', () => {
    expect(same('R S', 'Ravi Shankar')).toBe(false)
    expect(same('', 'Ravi Shankar')).toBe(false)
  })
})
