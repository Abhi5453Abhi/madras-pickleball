import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  typedRoutes: true,
  // Native/WASM packages must not be bundled — PGlite ships a .data file it
  // loads by path, and argon2 is a native binding.
  serverExternalPackages: ['@electric-sql/pglite', '@node-rs/argon2', 'postgres'],
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  /**
   * A capability URL must not travel in a `Referer`. Browsers already default
   * to `strict-origin-when-cross-origin`, which keeps the path off a
   * cross-origin request — but the default is a browser's to change, and these
   * two paths ARE the credential, so they say it themselves.
   */
  async headers() {
    const guard = [
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
    ]
    // Two plain entries rather than one pattern: the matcher syntax is the
    // framework's to change, and a header that silently stops matching is a
    // header that is not there.
    return [
      { source: '/s/:token', headers: guard },
      { source: '/r/:token', headers: guard },
    ]
  },
  experimental: {
    serverActions: {
      // Origin-vs-Host check is the CSRF defence for Server Actions (SPEC A9).
      allowedOrigins: process.env.APP_ORIGINS?.split(',').filter(Boolean) ?? [],
    },
  },
}

export default nextConfig
