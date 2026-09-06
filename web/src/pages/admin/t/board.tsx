import { Navigate } from 'react-router'

/**
 * The per-tournament board is gone. There is one board for the whole venue —
 * every court, every tournament running today — at /admin/live.
 */
export function TournamentBoardPage() {
  return <Navigate to="/admin/live" replace />
}
