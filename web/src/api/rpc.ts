import type { Registry } from './contract'

export type RpcName = keyof Registry
export type Input<N extends RpcName> = Registry[N]['input']
export type Output<N extends RpcName> = Registry[N]['output']

/**
 * A refusal the server made on purpose: a status and a sentence for a
 * person. 401 and 403 also carry where the app should go instead.
 */
export class RpcError extends Error {
  status: number
  redirect?: string
  constructor(status: number, message: string, redirect?: string) {
    super(message)
    this.status = status
    this.redirect = redirect
  }
}

/**
 * One POST per server function — docs/GO-API.ts is the contract. Throws
 * RpcError for 4xx/5xx; a refused action (`{ok:false, error}`) is a normal
 * result, not an error, so the screen can print the sentence.
 */
export async function rpc<N extends RpcName>(name: N, input: Input<N>): Promise<Output<N>> {
  let res: Response
  try {
    res = await fetch(`/api/rpc/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(input ?? {}),
    })
  } catch {
    throw new RpcError(0, 'No connection. Check the wifi and try again.')
  }
  if (!res.ok) {
    let body: { error?: string; redirect?: string } = {}
    try {
      body = await res.json()
    } catch {
      /* not JSON */
    }
    if (res.status === 401) {
      const next = location.pathname + location.search
      throw new RpcError(401, body.error ?? 'Sign in first.', `/login?next=${encodeURIComponent(next)}`)
    }
    throw new RpcError(res.status, body.error ?? 'Something went wrong on our side. Try again in a moment.', body.redirect)
  }
  return (await res.json()) as Output<N>
}

/** The version pollers are plain GETs. */
export async function version(path: 'today' | `t/${string}` | 'venue'): Promise<string | null> {
  try {
    const res = await fetch(`/api/version/${path}`, { credentials: 'same-origin', cache: 'no-store' })
    if (!res.ok) return null
    const body = (await res.json()) as { version: string }
    return body.version
  } catch {
    return null
  }
}
