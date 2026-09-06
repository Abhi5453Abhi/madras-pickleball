import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { rpc, RpcError, type Input, type Output, type RpcName } from './rpc'

export type Loaded<T> =
  | { state: 'loading'; data?: undefined; error?: undefined }
  | { state: 'ready'; data: T; error?: undefined }
  | { state: 'missing'; data?: undefined; error: string }
  | { state: 'error'; data?: undefined; error: string }

/**
 * Loads one RPC for a screen and reloads it on demand. A 401 sends the
 * browser to /login (with ?next=), a 403 to wherever the server said, a 404
 * becomes `missing` so the screen can say "no such tournament" itself.
 */
export function useRpc<N extends RpcName>(name: N, input: Input<N>, deps: unknown[] = []) {
  const navigate = useNavigate()
  const [result, setResult] = useState<Loaded<Output<N>>>({ state: 'loading' })
  const key = JSON.stringify(input)

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setResult({ state: 'loading' })
      try {
        const data = await rpc(name, JSON.parse(key) as Input<N>)
        setResult({ state: 'ready', data })
      } catch (e) {
        if (e instanceof RpcError) {
          if (e.redirect) {
            navigate(e.redirect, { replace: true })
            return
          }
          if (e.status === 404) {
            setResult({ state: 'missing', error: e.message })
            return
          }
          setResult({ state: 'error', error: e.message })
          return
        }
        setResult({ state: 'error', error: 'Something went wrong. Try again in a moment.' })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [name, key, navigate, ...deps],
  )

  useEffect(() => {
    void load()
  }, [load])

  return { ...result, reload: (quiet = true) => load(quiet) }
}

/**
 * For buttons: runs an action RPC, follows a `redirect` the server hands
 * back, and returns the result for the screen to print.
 */
export function useAction() {
  const navigate = useNavigate()
  const [pending, setPending] = useState(false)
  const run = useCallback(
    async <N extends RpcName>(name: N, input: Input<N>): Promise<Output<N> | { ok: false; error: string }> => {
      setPending(true)
      try {
        const out = await rpc(name, input)
        const r = out as unknown as { ok?: boolean; redirect?: string }
        if (r && r.ok && r.redirect) navigate(r.redirect)
        return out
      } catch (e) {
        if (e instanceof RpcError && e.redirect) {
          navigate(e.redirect, { replace: true })
        }
        return { ok: false, error: e instanceof Error ? e.message : 'Something went wrong.' }
      } finally {
        setPending(false)
      }
    },
    [navigate],
  )
  return { run, pending }
}
