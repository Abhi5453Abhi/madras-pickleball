import { useEffect } from 'react'
import { markPending } from './api/use-rpc'
import { Route, Routes } from 'react-router'
import { NotFound } from './pages/not-found'
import { TodayPage } from './pages/today'
import { LoginPage } from './pages/login'
import { SignupPage } from './pages/signup'
import { PublicTournamentPage } from './pages/public-tournament'
import { AdminLayout } from './pages/admin/layout'
import { DashboardPage } from './pages/admin/dashboard'
import { NewTournamentPage } from './pages/admin/new'
import { AccountPage } from './pages/admin/account'
import { CourtsPage } from './pages/admin/courts'
import { LiveBoardPage } from './pages/admin/live'
import { MovePage } from './pages/admin/move'
import { ScorePage } from './pages/admin/score'
import { HubPage } from './pages/admin/t/hub'
import { RegistrationPage } from './pages/admin/t/registration'
import { TeamsPage } from './pages/admin/t/teams'
import { PairWithPage } from './pages/admin/t/pair'
import { SchedulePage } from './pages/admin/t/schedule'
import { ResultsPage } from './pages/admin/t/results'
import { MorePage } from './pages/admin/t/more'
import { TournamentBoardPage } from './pages/admin/t/board'

/**
 * The same URLs as the Next.js app, on purpose: the browser walks in
 * app/scripts drive these addresses and are the acceptance test of the port.
 * Each page lives in src/pages and loads its own data through useRpc.
 *
 * Everything under /admin sits inside one layout route — the ink band, the
 * initials button, and the `auth.me` call that sends a signed-out visitor to
 * /login and an organiser on a temporary PIN to /admin/account.
 */
export function App() {
  // Mounted: from here on data-pending counts the loads in flight.
  useEffect(() => markPending(0), [])
  return (
    <Routes>
      <Route path="/" element={<TodayPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/r/:token" element={<SignupPage />} />
      <Route path="/t/:slug" element={<PublicTournamentPage />} />
      <Route element={<AdminLayout />}>
        <Route path="/admin" element={<DashboardPage />} />
        <Route path="/admin/new" element={<NewTournamentPage />} />
        <Route path="/admin/account" element={<AccountPage />} />
        <Route path="/admin/courts" element={<CourtsPage />} />
        <Route path="/admin/live" element={<LiveBoardPage />} />
        <Route path="/admin/live/move/:matchId" element={<MovePage />} />
        <Route path="/admin/m/:matchId" element={<ScorePage />} />
        <Route path="/admin/t/:slug" element={<HubPage />} />
        <Route path="/admin/t/:slug/registration" element={<RegistrationPage />} />
        <Route path="/admin/t/:slug/teams" element={<TeamsPage />} />
        <Route path="/admin/t/:slug/teams/pair/:playerId" element={<PairWithPage />} />
        <Route path="/admin/t/:slug/schedule" element={<SchedulePage />} />
        <Route path="/admin/t/:slug/results" element={<ResultsPage />} />
        <Route path="/admin/t/:slug/more" element={<MorePage />} />
        <Route path="/admin/t/:slug/board" element={<TournamentBoardPage />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}
