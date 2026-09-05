import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  typedRoutes: true,
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  experimental: {
    serverActions: {
      // Origin-vs-Host check is the CSRF defence for Server Actions (SPEC A9).
      allowedOrigins: process.env.APP_ORIGINS?.split(',').filter(Boolean) ?? [],
    },
  },
}

export default nextConfig
