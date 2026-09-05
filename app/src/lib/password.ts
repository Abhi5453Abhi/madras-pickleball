import { hash, verify } from '@node-rs/argon2'

/**
 * argon2id via @node-rs/argon2 — ships prebuilt, where the native `argon2`
 * package can fail to build on Vercel (SPEC A9).
 */
/** 2 = Argon2id. The enum is `const`, which isolatedModules cannot import. */
const OPTS = { algorithm: 2 as const, memoryCost: 19456, timeCost: 2, parallelism: 1 }

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTS)
}

export async function verifyPassword(digest: string, plain: string): Promise<boolean> {
  try {
    // No options here: the encoded hash carries its own parameters, and passing
    // ours makes @node-rs/argon2 verify against the wrong ones.
    return await verify(digest, plain)
  } catch {
    return false
  }
}

export const hashPin = hashPassword
export const verifyPin = verifyPassword
