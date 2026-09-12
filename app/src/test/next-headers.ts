/**
 * Stands in for `next/headers` under vitest.
 *
 * Only `resolveSpotToken` reaches for it, and only to hash a client IP for the
 * rate limiter. Nothing in the test suite calls that path, so this exists to
 * make the import resolve — and to fail loudly rather than silently pretending
 * there is a request if something ever does.
 */
export async function headers(): Promise<Headers> {
  throw new Error('headers() is not available in tests — this path needs a request.')
}

export async function cookies(): Promise<never> {
  throw new Error('cookies() is not available in tests — this path needs a request.')
}
