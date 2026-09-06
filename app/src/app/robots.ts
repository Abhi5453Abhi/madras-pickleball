import type { MetadataRoute } from 'next'

/**
 * The public tournament page is meant to be found; nothing else is.
 *
 * `/c/` and `/r/` are capability URLs — a search engine holding one is the same
 * as the link having leaked — and the admin and umpire areas have no business
 * in an index at all.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/admin', '/umpire', '/c/', '/r/', '/court', '/login', '/api/'],
      },
    ],
  }
}
