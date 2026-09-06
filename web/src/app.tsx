import { Route, Routes } from 'react-router'
import { NotFound } from './pages/not-found'
import { Placeholder } from './pages/placeholder'

/**
 * The same URLs as the Next.js app, on purpose: the browser walks in
 * app/scripts drive these addresses and are the acceptance test of the port.
 * Each page lives in src/pages and loads its own data through useRpc.
 */
export function App() {
  return (
    <Routes>
      <Route path="/" element={<Placeholder name="Today" />} />
      <Route path="/login" element={<Placeholder name="Sign in" />} />
      <Route path="/r/:token" element={<Placeholder name="Sign up" />} />
      <Route path="/t/:slug" element={<Placeholder name="Public tournament" />} />
      <Route path="/admin" element={<Placeholder name="Dashboard" />} />
      <Route path="/admin/new" element={<Placeholder name="New tournament" />} />
      <Route path="/admin/account" element={<Placeholder name="Your account" />} />
      <Route path="/admin/courts" element={<Placeholder name="The venue’s courts" />} />
      <Route path="/admin/live" element={<Placeholder name="Live board" />} />
      <Route path="/admin/live/move/:matchId" element={<Placeholder name="Move" />} />
      <Route path="/admin/m/:matchId" element={<Placeholder name="Score entry" />} />
      <Route path="/admin/t/:slug" element={<Placeholder name="Tournament" />} />
      <Route path="/admin/t/:slug/registration" element={<Placeholder name="Registration" />} />
      <Route path="/admin/t/:slug/teams" element={<Placeholder name="Teams" />} />
      <Route path="/admin/t/:slug/teams/pair/:playerId" element={<Placeholder name="Pair with" />} />
      <Route path="/admin/t/:slug/schedule" element={<Placeholder name="Schedule & courts" />} />
      <Route path="/admin/t/:slug/results" element={<Placeholder name="Results" />} />
      <Route path="/admin/t/:slug/more" element={<Placeholder name="More" />} />
      <Route path="/admin/t/:slug/board" element={<Placeholder name="Board" />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}
