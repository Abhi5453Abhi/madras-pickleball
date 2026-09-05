import { customAlphabet } from 'nanoid'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const gen = customAlphabet(ALPHABET, 20)

/** Sortable-ish, URL-safe, collision-resistant id. */
export function newId(prefix?: string): string {
  const id = gen()
  return prefix ? `${prefix}_${id}` : id
}
