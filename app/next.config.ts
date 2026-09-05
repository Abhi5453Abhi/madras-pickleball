import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  typedRoutes: true,
  // Native/WASM packages must not be bundled — PGlite ships a .data file it
  // loads by path, and argon2 is a native binding.
  serverExternalPackages: ['@electric-sql/pglite', '@node-rs/argon2', 'postgres'],
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  experimental: {
    serverActions: {
      // Origin-vs-Host check is the CSRF defence for Server Actions (SPEC A9).
      allowedOrigins: process.env.APP_ORIGINS?.split(',').filter(Boolean) ?? [],
    },
  },
}

export default nextConfig
