import { NextResponse, type NextRequest } from 'next/server'

/**
 * A cheap cookie-presence redirect only. Real authorization happens server-side
 * in every page and action — the proxy is never the security boundary (SPEC A9).
 */
const SESSION_COOKIE =
  process.env.NODE_ENV === 'production' ? '__Host-mpb_session' : 'mpb_session'

export function proxy(request: NextRequest) {
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next()

  const url = new URL('/login', request.nextUrl)
  url.searchParams.set('next', request.nextUrl.pathname)
  return NextResponse.redirect(url)
}

export const config = {
  // Only the organiser area. Public pages and the sign-up form are reachable
  // without any cookie, and public routes must stay cookie-free so the CDN
  // keeps caching them (SPEC A9).
  matcher: ['/admin/:path*'],
}
