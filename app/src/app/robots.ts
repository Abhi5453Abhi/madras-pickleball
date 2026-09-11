import type { MetadataRoute } from 'next'

/**
 * The public tournament page and the games list are meant to be found; nothing
 * else is.
 *
 * `/r/` and `/s/` are capability URLs — a search engine holding one is the same
 * as the link having leaked — and the organiser area has no business in an index
 * at all.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/admin', '/r/', '/s/', '/login', '/api/'],
      },
    ],
  }
}
