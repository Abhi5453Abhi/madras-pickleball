import type { MetadataRoute } from 'next'

/**
 * The public tournament page is meant to be found; nothing else is.
 *
 * `/r/` is a capability URL — a search engine holding one is the same as the
 * link having leaked — and the organiser area has no business in an index at
 * all.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/admin', '/r/', '/login', '/api/'],
      },
    ],
  }
}
