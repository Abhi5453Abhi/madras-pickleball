import { redirect } from 'next/navigation'

/**
 * The per-tournament board is gone. There is one board for the whole venue —
 * every court, every tournament running today — at /admin/live.
 */
export default function BoardPage() {
  redirect('/admin/live')
}
