import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Madras Pickleball',
  description: 'Tournaments, live scores and results at Madras Pickleball.',
}

export const viewport: Viewport = {
  themeColor: '#0e3a5e',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

/**
 * `en-IN`: the venue is in Chennai, the copy is British English, and the names
 * on every screen are Tamil. It is what a screen reader needs to say them.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" className="h-full">
      <body className="min-h-full antialiased">{children}</body>
    </html>
  )
}
