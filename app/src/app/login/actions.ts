'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { createSession, destroySession } from '@/lib/session'
import { checkPinAllowed, recordPinAttempt } from '@/lib/rate-limit'
import { hashIp } from '@/lib/crypto'
import { normalizePin, organiserForPin } from '@/server/organisers'

export type LoginState = { error?: string }

function safeNext(raw: unknown): string {
  const s = String(raw ?? '')
  // Only somewhere inside the organiser area, on this site.
  return s.startsWith('/admin') && !s.startsWith('//') ? s : '/admin'
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const pin = normalizePin(formData.get('pin'))
  const next = safeNext(formData.get('next'))

  const h = await headers()
  const ipHash = hashIp(h.get('x-forwarded-for')?.split(',')[0]?.trim())

  const gate = await checkPinAllowed(ipHash)
  if (!gate.allowed) {
    return {
      error: `Too many wrong PINs. Try again in ${gate.retryInMinutes} minute${
        gate.retryInMinutes === 1 ? '' : 's'
      }.`,
    }
  }

  // A PIN that is not six digits is wrong before it is checked — and it still
  // counts, or the shape of the input becomes a free oracle.
  const user = pin ? await organiserForPin(pin) : null
  await recordPinAttempt(ipHash, !!user, user?.id)

  if (!user) {
    const left = gate.triesLeft - 1
    return {
      error:
        left > 0
          ? `That's not it. ${left} ${left === 1 ? 'try' : 'tries'} left before a fifteen-minute wait.`
          : 'That’s not it. Wait fifteen minutes before trying again.',
    }
  }

  await createSession({
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
  })

  // redirect() throws, so it must be the last thing and outside any try block.
  redirect((user.mustChangePassword ? '/admin/account?first=1' : next) as never)
}

export async function logout() {
  await destroySession()
  redirect('/login')
}
