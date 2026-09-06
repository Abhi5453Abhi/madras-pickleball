/** Clears PIN lockouts and the attempt window — for the organiser who typed it wrong five times. */
import 'dotenv/config'
import { db } from '../src/db'
import { loginAttempts, tokenAttempts, users } from '../src/db/schema'

async function main() {
  await db.delete(loginAttempts)
  await db.delete(tokenAttempts)
  await db.update(users).set({ failedLoginCount: 0, lockedUntil: null })
  console.log('lockouts cleared')
  process.exit(0)
}
main()
