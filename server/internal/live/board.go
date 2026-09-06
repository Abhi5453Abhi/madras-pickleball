package live

// The court board — SPEC A4, ported from app/src/server/board.ts.
//
// A tournament has its own courts and its matches never leave them. The next
// match in order goes onto whichever of those courts is free, on its own, so
// the organiser does nothing but enter scores. `loadBoard` is one tournament's
// view; `venueBoard` is every court at the venue at once, which is the screen
// the organiser actually looks at.

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strings"
	"time"

	"mpb/internal/core"
	"mpb/internal/db"
	"mpb/internal/engine"
	"mpb/internal/rpc"
	"mpb/internal/store"
)

// overrunFactor — how far past its expected length a match has to be before
// the board asks about it. Generous: the failure it catches is a pair who
// walked off for water and never gave anyone a score, not a long third game.
const overrunFactor = 1.6

// boardMatch is one match as the board reasons about it. The wire shape the
// screens read is smaller; see wireMatch.
type boardMatch struct {
	ID          string
	RoundName   *string
	RoundIndex  int
	Seq         int
	TeamAID     *string
	TeamBID     *string
	NameA       *string
	NameB       *string
	Status      string
	ResultState string
	CourtID     *string
	StartedAt   *time.Time
	// BlockedBy names the player who is already on court somewhere else.
	BlockedBy *string
	// Ready — both slots resolved.
	Ready bool
	// WaitingOn is what an unready match is waiting for, in words — "Waiting
	// for the winner of Semi-final 1". Hiding these made the board's own count
	// of matches left disagree with the list under it.
	WaitingOn *string
	// OverrunMinutes is how long it has been on court, once that is far
	// enough past what its format should take to be worth asking about.
	OverrunMinutes *int
	// PlayerIDs — so two courts are never offered matches sharing a player.
	PlayerIDs []string
	OnHold    bool
}

type boardCourt struct {
	ID       string
	Name     string
	ColorKey string
	// Closed is always false in v4: the port has no court-closure table. Kept
	// so the "Out of action" band survives if one is ever added.
	Closed       bool
	ClosedReason *string
	Live         *boardMatch
	// BusyElsewhere: another tournament has a match on this court. Nothing of
	// ours goes on it, and there is nothing for this board to say about it.
	BusyElsewhere bool
	// FreeSinceMinutes — how long this court has been standing empty.
	FreeSinceMinutes *int
}

type boardData struct {
	Tournament *store.Tournament
	Courts     []boardCourt
	// Queue is what is playable and not on a court, in the order of play.
	Queue []boardMatch
	// Waiting is not yet playable: waiting on an earlier result. Shown, never
	// hidden.
	Waiting   []boardMatch
	LiveCount int
	// Remaining is everything with no result, INCLUDING what is on court.
	Remaining  int
	Played     int
	PausedNote *string
	OpenCourts int
	FinishAt   *time.Time
}

// ── one tournament's board ────────────────────────────────────────────────

func loadBoard(ctx context.Context, q core.Querier, d *core.Deps, t *store.Tournament) (*boardData, error) {
	courtRows, err := tournamentCourts(ctx, q, t.ID)
	if err != nil {
		return nil, err
	}
	all, err := store.Matches(ctx, q, t.ID)
	if err != nil {
		return nil, err
	}
	sortByPlayOrder(all)
	teamNames, err := store.TeamNames(ctx, q, t.ID)
	if err != nil {
		return nil, err
	}
	roster, err := playersByTournament(ctx, q, t.ID)
	if err != nil {
		return nil, err
	}
	elsewhere, err := busyElsewhere(ctx, q, t.VenueID, t.ID)
	if err != nil {
		return nil, err
	}
	venueLive, err := liveMatchesAtVenue(ctx, q, t.VenueID)
	if err != nil {
		return nil, err
	}
	now := d.Now()

	courtName := make(map[string]string, len(courtRows))
	for _, c := range courtRows {
		courtName[c.ID] = c.Name
	}

	// Who is physically on a court right now, in this tournament or any other.
	busy := map[string]string{}
	for id, where := range elsewhere {
		busy[id] = where
	}
	liveByCourt := map[string]*store.Match{}
	for _, m := range all {
		if m.Status != "live" {
			continue
		}
		if m.CourtID != nil {
			liveByCourt[*m.CourtID] = m
		}
		where := "another court"
		if m.CourtID != nil {
			if n, ok := courtName[*m.CourtID]; ok {
				where = n
			}
		}
		for _, p := range roster[m.ID] {
			busy[p.ID] = where
		}
	}

	// Courts another tournament is playing on. One court belongs to one
	// tournament per day, so this only bites across days — but a match that is
	// physically on a court is on it whatever the calendar says.
	otherCourt := map[string]bool{}
	for _, m := range venueLive {
		if m.TournamentID != t.ID && m.CourtID != nil {
			otherCourt[*m.CourtID] = true
		}
	}

	waiting := waitingLabels(all)
	expected := engine.MinutesPerMatch(engine.FormatShape{BestOf: t.BestOf, PointsToWin: t.PointsToWin})

	toBoardMatch := func(m *store.Match) boardMatch {
		ready := m.TeamAID != nil && m.TeamBID != nil
		var blockedBy *string
		if ready && m.Status != "live" {
			for _, p := range roster[m.ID] {
				if where, ok := busy[p.ID]; ok {
					// The reason IS the button label. Naming the person is what
					// turns "blocked" into something the organiser can act on.
					blockedBy = strp(p.Name + " is on " + where)
					break
				}
			}
		}
		var overrun *int
		if m.Status == "live" && m.StartedAt != nil {
			elapsed := minutesSince(*m.StartedAt, now)
			if float64(elapsed) > float64(expected)*overrunFactor {
				overrun = intp(elapsed)
			}
		}
		var nameA, nameB *string
		if m.TeamAID != nil {
			if n, ok := teamNames[*m.TeamAID]; ok {
				nameA = strp(n)
			}
		}
		if m.TeamBID != nil {
			if n, ok := teamNames[*m.TeamBID]; ok {
				nameB = strp(n)
			}
		}
		var waitingOn *string
		if !ready {
			if label, ok := waiting[m.ID]; ok {
				waitingOn = strp(label)
			} else {
				waitingOn = strp("an earlier result")
			}
		}
		ids := make([]string, 0, len(roster[m.ID]))
		for _, p := range roster[m.ID] {
			ids = append(ids, p.ID)
		}
		return boardMatch{
			ID: m.ID, RoundName: m.RoundName, RoundIndex: m.RoundIndex, Seq: m.Seq,
			TeamAID: m.TeamAID, TeamBID: m.TeamBID, NameA: nameA, NameB: nameB,
			Status: m.Status, ResultState: m.ResultState, CourtID: m.CourtID, StartedAt: m.StartedAt,
			BlockedBy: blockedBy, Ready: ready, WaitingOn: waitingOn, OverrunMinutes: overrun,
			PlayerIDs: ids, OnHold: m.OnHold,
		}
	}

	// When a court last had a match end on it, so an idle court can say how
	// long it has been idle.
	lastEnded := map[string]time.Time{}
	for _, m := range all {
		if m.CourtID == nil || m.EndedAt == nil {
			continue
		}
		if prev, ok := lastEnded[*m.CourtID]; !ok || m.EndedAt.After(prev) {
			lastEnded[*m.CourtID] = *m.EndedAt
		}
	}

	courts := make([]boardCourt, 0, len(courtRows))
	liveCount := 0
	for _, c := range courtRows {
		bc := boardCourt{ID: c.ID, Name: c.Name, ColorKey: c.ColorKey, BusyElsewhere: otherCourt[c.ID]}
		if m, ok := liveByCourt[c.ID]; ok {
			bm := toBoardMatch(m)
			bc.Live = &bm
			liveCount++
		} else if end, ok := lastEnded[c.ID]; ok {
			bc.FreeSinceMinutes = intp(minutesSince(end, now))
		}
		courts = append(courts, bc)
	}

	// Everything still to happen, INCLUDING what is on court right now.
	// Leaving live matches out made the board print "Done" with four matches in
	// play, and shortened the finish estimate by half an hour per court.
	var queue, waitingList []boardMatch
	outstanding, played := 0, 0
	for _, m := range all {
		switch m.ResultState {
		case "none":
			outstanding++
		case "final":
			played++
		}
		if m.ResultState != "none" {
			continue
		}
		if m.Status == "live" || m.CourtID != nil {
			continue
		}
		bm := toBoardMatch(m)
		if bm.Ready {
			queue = append(queue, bm)
		} else {
			waitingList = append(waitingList, bm)
		}
	}

	openCourts := 0
	for _, c := range courts {
		if !c.Closed {
			openCourts++
		}
	}

	// A stopped day does not finish any earlier for standing still. Counting
	// the minutes since the pause is what makes the estimate tell the truth
	// while everyone is sheltering under the awning.
	pausedMinutes := 0
	if t.PausedAt != nil {
		pausedMinutes = minutesSince(*t.PausedAt, now)
	}
	var finishAt *time.Time
	if outstanding > 0 {
		est := engine.EstimateDay(engine.EstimateInput{
			Categories: []engine.CategoryLoad{{
				Name:            engine.CategoryName(t.Gender, t.Discipline),
				MatchCount:      outstanding,
				MinutesPerMatch: expected,
			}},
			Courts:       openCourts,
			StartAt:      &now,
			BreakMinutes: pausedMinutes,
		})
		finishAt = est.FinishAt
	}

	return &boardData{
		Tournament: t, Courts: courts, Queue: queue, Waiting: waitingList,
		LiveCount: liveCount, Remaining: outstanding, Played: played,
		PausedNote: t.PauseNote, OpenCourts: openCourts, FinishAt: finishAt,
	}, nil
}

// sortByPlayOrder is the order of play: a match the organiser has queued by
// hand first, then the draw's own order.
func sortByPlayOrder(ms []*store.Match) {
	sort.SliceStable(ms, func(i, j int) bool {
		a, b := ms[i], ms[j]
		qa, qb := a.QueuePosition, b.QueuePosition
		if (qa == nil) != (qb == nil) {
			return qa != nil
		}
		if qa != nil && *qa != *qb {
			return *qa < *qb
		}
		if a.RoundIndex != b.RoundIndex {
			return a.RoundIndex < b.RoundIndex
		}
		return a.Seq < b.Seq
	})
}

// waitingLabels — "Waiting for the winner of Semi-final 1", "Waiting for the
// 1st and 2nd in the group". The board used to drop these rows entirely, so the
// header said 7 to play above a list of 4.
func waitingLabels(all []*store.Match) map[string]string {
	byID := make(map[string]*store.Match, len(all))
	for _, m := range all {
		byID[m.ID] = m
	}
	out := map[string]string{}
	for _, m := range all {
		if m.TeamAID != nil && m.TeamBID != nil {
			continue
		}
		var labels []string
		for _, side := range []struct {
			filled *string
			src    store.SlotSource
		}{{m.TeamAID, m.SourceA}, {m.TeamBID, m.SourceB}} {
			// Only describe the side that is actually still empty.
			if side.filled != nil {
				continue
			}
			label := ""
			switch side.src.Type {
			case "winner_of", "loser_of":
				name := "an earlier match"
				if src, ok := byID[side.src.MatchID]; ok && src.RoundName != nil {
					name = *src.RoundName
				}
				word := "winner of "
				if side.src.Type == "loser_of" {
					word = "loser of "
				}
				label = word + name
			case "group_rank":
				if side.src.Rank > 0 {
					label = ordinal(side.src.Rank) + " in the group"
				}
			}
			if label != "" {
				labels = append(labels, label)
			}
		}
		if len(labels) == 0 {
			continue
		}
		// "Waiting for the 1st and 2nd in the group" — the shared tail is said
		// once. The board prints this on a card, and the long form wrapped off
		// it.
		const tail = "in the group"
		short := ""
		if len(labels) == 2 && strings.HasSuffix(labels[0], tail) && strings.HasSuffix(labels[1], tail) {
			heads := make([]string, 2)
			for i, l := range labels {
				heads[i] = strings.TrimSpace(strings.TrimSuffix(l, tail))
			}
			short = heads[0] + " and " + heads[1] + " " + tail
		} else {
			short = strings.Join(labels, " and the ")
		}
		out[m.ID] = "Waiting for the " + short
	}
	return out
}

func ordinal(n int) string {
	switch n {
	case 1:
		return "1st"
	case 2:
		return "2nd"
	case 3:
		return "3rd"
	}
	return fmt.Sprintf("%dth", n)
}

// ── which match to offer each free court ──────────────────────────────────

type offer struct {
	CourtID string
	Match   boardMatch
}

// offersForFreeCourts — each free court is offered a DIFFERENT match, and never
// one that shares a player with a match already offered somewhere else. Handing
// Court 1 and Court 2 two matches that both contain Ravi meant the second was
// refused, which is the exact collision the board exists to prevent.
//
// This is the one queue. The auto-flow places what it offers; the board's "Next
// here" line predicts from the same rule. Two functions that disagree about
// which pair is next is worse than either answer.
func offersForFreeCourts(data *boardData, skip map[string]bool) []offer {
	var placeable []boardMatch
	for _, m := range data.Queue {
		if !m.Ready || m.BlockedBy != nil || m.OnHold || skip[m.ID] {
			continue
		}
		placeable = append(placeable, m)
	}
	var out []offer
	taken := map[string]bool{}
	spokenFor := map[string]bool{}
	for _, c := range data.Courts {
		if c.Closed || c.Live != nil || c.BusyElsewhere {
			continue
		}
		for _, m := range placeable {
			if taken[m.ID] {
				continue
			}
			clash := false
			for _, p := range m.PlayerIDs {
				if spokenFor[p] {
					clash = true
					break
				}
			}
			if clash {
				continue
			}
			out = append(out, offer{CourtID: c.ID, Match: m})
			taken[m.ID] = true
			for _, p := range m.PlayerIDs {
				spokenFor[p] = true
			}
			break
		}
	}
	return out
}

// ── the flow ──────────────────────────────────────────────────────────────

// FlowTournament is the hook every write in every module calls, inside its own
// transaction, after its write: it resolves the slots that have become known,
// makes ready what can be played, and fills this tournament's free courts with
// the next matches in order.
//
// Idempotent and cheap. Nothing goes on while the tournament is paused, and
// nothing goes on a court belonging to somebody else.
func FlowTournament(ctx context.Context, tx *sql.Tx, d *core.Deps, tournamentID string) error {
	return flowTournament(ctx, tx, d, tournamentID, nil)
}

func flowTournament(ctx context.Context, tx *sql.Tx, d *core.Deps, tournamentID string, skip map[string]bool) error {
	// The row lock is what makes two flows take turns rather than race: a score
	// saved on each of two courts in the same second would otherwise both pick
	// the same next match from the same snapshot.
	t, err := store.TournamentByIDForUpdate(ctx, tx, d.Venue.ID, tournamentID)
	if err != nil {
		if store.IsNotFound(err) {
			return nil
		}
		return err
	}
	if err := resolveSlots(ctx, tx, d, t); err != nil {
		return err
	}
	// A paused tournament sends nothing; a tournament that has not started, or
	// is finished, has nothing to send.
	if t.Status != "live" || t.PausedAt != nil {
		return nil
	}
	data, err := loadBoard(ctx, tx, d, t)
	if err != nil {
		return err
	}
	free := false
	for _, c := range data.Courts {
		if !c.Closed && c.Live == nil && !c.BusyElsewhere {
			free = true
			break
		}
	}
	if !free {
		return nil
	}
	for _, o := range offersForFreeCourts(data, skip) {
		// One at a time: each send re-checks the court and the players against
		// the database as it is now, not as the snapshot above had it.
		if _, err := sendToCourt(ctx, tx, d, t, o.Match.ID, o.CourtID); err != nil {
			return err
		}
	}
	return nil
}

// flowVenue flows every tournament running today, `first` before the rest. A
// saved score frees a court in one tournament — and may free a PLAYER another
// tournament's court was waiting on, because one person can be in Men's and
// Mixed on the same Sunday.
func flowVenue(ctx context.Context, tx *sql.Tx, d *core.Deps, first string, skip map[string]bool) error {
	ids, err := liveTournamentIDs(ctx, tx, d.Venue.ID)
	if err != nil {
		return err
	}
	ordered := make([]string, 0, len(ids))
	if first != "" {
		ordered = append(ordered, first)
	}
	for _, id := range ids {
		if id != first {
			ordered = append(ordered, id)
		}
	}
	for _, id := range ordered {
		s := skip
		if id != first {
			s = nil
		}
		if err := flowTournament(ctx, tx, d, id, s); err != nil {
			return err
		}
	}
	return nil
}

// ── placing a match ───────────────────────────────────────────────────────

// sendToCourt puts a match on a court. The unique index on
// matches(court_id) where status='live' makes double-booking structurally
// impossible; this turns the violation into a sentence rather than a 500 on
// tournament morning. It returns the refusal, or "" when the match went on.
func sendToCourt(ctx context.Context, tx *sql.Tx, d *core.Deps, t *store.Tournament, matchID, courtID string) (string, error) {
	match, err := store.MatchByIDForUpdate(ctx, tx, matchID)
	if err != nil {
		if store.IsNotFound(err) {
			return "That match no longer exists.", nil
		}
		return "", err
	}
	if match.TournamentID != t.ID {
		return "That match no longer exists.", nil
	}
	if match.TeamAID == nil || match.TeamBID == nil {
		return "This match is still waiting on an earlier result.", nil
	}
	if match.ResultState != "none" {
		return "This match already has a result.", nil
	}
	// Two flows running at once both pick the same next match from the same
	// snapshot. The second send must not quietly move a match that just went on.
	if match.Status == "live" {
		return "This match is already on a court.", nil
	}

	court, err := courtByID(ctx, tx, d.Venue.ID, courtID)
	if err != nil {
		return "That court no longer exists.", nil
	}
	if !court.Active {
		return "That court no longer exists.", nil
	}
	held, err := holdsCourt(ctx, tx, t.ID, courtID)
	if err != nil {
		return "", err
	}
	// A match only ever goes onto its own tournament's courts. Enforced here,
	// not in the screens: the Move list never offers another tournament's
	// court, but a form field is a wire value and this is the write.
	if !held {
		return court.Name + " isn’t one of this tournament’s courts — a match only goes on its own tournament’s courts.", nil
	}
	busy, err := courtBusy(ctx, tx, courtID, matchID)
	if err != nil {
		return "", err
	}
	if busy {
		return court.Name + " already has a match on it.", nil
	}

	// The conflict check has to run HERE, not only when the board rendered.
	// Otherwise two sends from a stale board put the same player on two courts
	// — the one thing this product exists to prevent.
	conflict, err := livePlayerConflict(ctx, tx, d, matchID)
	if err != nil {
		return "", err
	}
	if conflict != "" {
		return conflict, nil
	}

	// The status is re-asserted in the WHERE because it was read before the
	// lock was taken on anything else.
	res, err := tx.ExecContext(ctx, `
		update matches set court_id = $2, status = 'live', started_at = now(),
			version = version + 1, updated_at = now()
		where id = $1 and status <> 'live' and result_state = 'none'`, matchID, courtID)
	if db.IsUniqueViolation(err) {
		// The one-live-per-court index caught a race the checks above could
		// not see (another tournament's match landed there this instant).
		return court.Name + " already has a match on it.", nil
	}
	if err != nil {
		return "", err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return "This match is already on a court.", nil
	}
	return "", core.Bump(ctx, tx, t.ID)
}

// livePlayerConflict names the player, because "blocked" is not actionable and
// a name is. Every live match at the venue counts, not only this tournament's:
// a person can be entered in two tournaments on the same day, and has one body.
func livePlayerConflict(ctx context.Context, q core.Querier, d *core.Deps, matchID string) (string, error) {
	live, err := liveMatchesAtVenue(ctx, q, d.Venue.ID)
	if err != nil {
		return "", err
	}
	if len(live) == 0 {
		return "", nil
	}
	names, err := courtNameMap(ctx, q, d.Venue.ID)
	if err != nil {
		return "", err
	}
	ids := []string{matchID}
	for _, m := range live {
		if m.ID != matchID {
			ids = append(ids, m.ID)
		}
	}
	rosters, err := playersForMatches(ctx, q, ids)
	if err != nil {
		return "", err
	}
	mine := map[string]bool{}
	for _, p := range rosters[matchID] {
		mine[p.ID] = true
	}
	for _, other := range live {
		if other.ID == matchID {
			continue
		}
		for _, p := range rosters[other.ID] {
			if mine[p.ID] {
				where := "another court"
				if other.CourtID != nil {
					if n, ok := names[*other.CourtID]; ok {
						where = n
					}
				}
				return p.Name + " is on " + where, nil
			}
		}
	}
	return "", nil
}

// moveMatch moves a live match to another of its own tournament's courts. The
// clock starts again on the new court — a moved match is a match that is
// starting, and a false "on for 52 min" is worse than a lost ten.
func moveMatch(ctx context.Context, tx *sql.Tx, d *core.Deps, matchID, courtID string) (string, error) {
	match, err := store.MatchByIDForUpdate(ctx, tx, matchID)
	if err != nil {
		if store.IsNotFound(err) {
			return "That match no longer exists.", nil
		}
		return "", err
	}
	if match.Status != "live" {
		return "That match isn’t on a court.", nil
	}
	if match.CourtID != nil && *match.CourtID == courtID {
		return "", nil
	}
	court, err := courtByID(ctx, tx, d.Venue.ID, courtID)
	if err != nil || !court.Active {
		return "That court no longer exists.", nil
	}
	held, err := holdsCourt(ctx, tx, match.TournamentID, courtID)
	if err != nil {
		return "", err
	}
	if !held {
		return court.Name + " isn’t one of this tournament’s courts — a match only goes on its own tournament’s courts.", nil
	}
	busy, err := courtBusy(ctx, tx, courtID, matchID)
	if err != nil {
		return "", err
	}
	if busy {
		return court.Name + " already has a match on it.", nil
	}
	if _, err := tx.ExecContext(ctx, `
		update matches set court_id = $2, started_at = now(), version = version + 1, updated_at = now()
		where id = $1 and status = 'live'`, matchID, courtID); err != nil {
		return "", err
	}
	return "", core.Bump(ctx, tx, match.TournamentID)
}

// clearCourt takes a match off court without recording a result. Only a LIVE
// match: doing this to a completed one resurrected a finished match and erased
// which court it was played on.
func clearCourt(ctx context.Context, tx *sql.Tx, d *core.Deps, matchID string, later bool) (string, error) {
	match, err := store.MatchByIDForUpdate(ctx, tx, matchID)
	if err != nil {
		if store.IsNotFound(err) {
			return "That match no longer exists.", nil
		}
		return "", err
	}
	if _, err := store.TournamentByID(ctx, tx, d.Venue.ID, match.TournamentID); err != nil {
		return "That match no longer exists.", nil
	}
	if match.Status != "live" {
		return "That match isn’t on a court.", nil
	}

	// "Play it later" has to mean something the next flow can see, or the court
	// it just left offers the same match straight back. The order of play is
	// (round, seq): a league match goes to the back of its stage and takes that
	// round's tag. A knockout match can only go to the back of its OWN round —
	// sending a semi-final behind the final renamed it "Final" and listed it
	// after the match it feeds.
	setOrder := ""
	args := []any{matchID}
	if later {
		knockout := match.Stage == "knockout"
		where := `tournament_id = $1 and stage = $2`
		qargs := []any{match.TournamentID, match.Stage}
		if knockout {
			where += ` and round_index = $3`
			qargs = append(qargs, match.RoundIndex)
		}
		var lastRound, lastSeq int
		var lastName sql.NullString
		err := tx.QueryRowContext(ctx,
			`select round_index, seq, round_name from matches where `+where+
				` order by round_index desc, seq desc limit 1`, qargs...).Scan(&lastRound, &lastSeq, &lastName)
		if err != nil && err != sql.ErrNoRows {
			return "", err
		}
		if err == nil && (lastRound != match.RoundIndex || lastSeq != match.Seq) {
			args = append(args, lastRound, lastSeq+1)
			setOrder = `, round_index = $2, seq = $3`
			if !knockout {
				args = append(args, core.StrPtr(lastName))
				setOrder += `, round_name = $4`
			}
		}
	}

	if _, err := tx.ExecContext(ctx, `
		update matches set status = 'ready', court_id = null, started_at = null`+setOrder+`,
			version = version + 1, updated_at = now()
		where id = $1`, args...); err != nil {
		return "", err
	}
	return "", core.Bump(ctx, tx, match.TournamentID)
}

// ── "Next here" ───────────────────────────────────────────────────────────

// courtEntry is what one court card says beyond its own name.
type courtEntry struct {
	ClosedReason *string
	Live         *boardMatch
	Next         *boardMatch
	NextNote     *string
	Offer        *boardMatch
	IdleReason   *string
}

// nextByCourt — "Next here" for each of one tournament's courts.
//
// A free court is offered what the flow would put on it (which, if the flow has
// done its job, is nothing — the offer is the safety net for a court that came
// free by a door the flow does not watch). A busy court is told the first match
// in order that could start once IT finishes: nothing sharing a player with a
// match on another court, nothing already promised to a court that will free up
// sooner.
func nextByCourt(data *boardData, categoryName string, paused bool) map[string]courtEntry {
	out := map[string]courtEntry{}
	offers := offersForFreeCourts(data, nil)
	offerByCourt := map[string]boardMatch{}
	promised := map[string]bool{}
	spokenFor := map[string]bool{}
	for _, o := range offers {
		offerByCourt[o.CourtID] = o.Match
		promised[o.Match.ID] = true
		for _, p := range o.Match.PlayerIDs {
			spokenFor[p] = true
		}
	}

	var liveCourts []boardCourt
	for _, c := range data.Courts {
		if c.Live != nil {
			liveCourts = append(liveCourts, c)
		}
	}

	waitingNote := func(courtID string) string {
		var others []string
		onThisCourt := false
		for _, c := range liveCourts {
			if c.ID == courtID {
				onThisCourt = true
				continue
			}
			others = append(others, c.Name)
		}
		label := "The next round"
		waitingOn := "waiting on an earlier result"
		if len(data.Waiting) > 0 {
			if n := data.Waiting[0].RoundName; n != nil {
				label = *n
			}
			if w := data.Waiting[0].WaitingOn; w != nil {
				waitingOn = strings.Replace(*w, "Waiting", "waiting", 1)
			}
		}
		if len(others) > 0 {
			return label + " · waiting on " + possessive(others)
		}
		if courtID != "" && onThisCourt {
			return label + " · waiting on this result"
		}
		return label + " · " + waitingOn
	}

	// Busy courts in the order they are likely to free up.
	busyInOrder := append([]boardCourt(nil), liveCourts...)
	sort.SliceStable(busyInOrder, func(i, j int) bool {
		var a, b int64
		if s := busyInOrder[i].Live.StartedAt; s != nil {
			a = s.UnixNano()
		}
		if s := busyInOrder[j].Live.StartedAt; s != nil {
			b = s.UnixNano()
		}
		return a < b
	})

	for _, c := range busyInOrder {
		onOtherCourts := map[string]bool{}
		for _, o := range liveCourts {
			if o.ID == c.ID {
				continue
			}
			for _, p := range o.Live.PlayerIDs {
				onOtherCourts[p] = true
			}
		}
		var pick *boardMatch
		for i := range data.Queue {
			m := data.Queue[i]
			if promised[m.ID] || m.OnHold {
				continue
			}
			clash := false
			for _, p := range m.PlayerIDs {
				if onOtherCourts[p] || spokenFor[p] {
					clash = true
					break
				}
			}
			if clash {
				continue
			}
			pick = &m
			break
		}
		if pick != nil {
			promised[pick.ID] = true
			for _, p := range pick.PlayerIDs {
				spokenFor[p] = true
			}
		}
		var note *string
		if pick == nil {
			unpromised := false
			for _, m := range data.Queue {
				if !promised[m.ID] {
					unpromised = true
					break
				}
			}
			switch {
			case unpromised:
				var others []string
				for _, o := range liveCourts {
					if o.ID != c.ID {
						others = append(others, o.Name)
					}
				}
				if len(others) > 0 {
					note = strp("waiting on " + possessive(others))
				}
			case len(data.Waiting) > 0:
				note = strp(waitingNote(c.ID))
			default:
				note = strp("This is the last one here")
			}
		}
		live := c.Live
		out[c.ID] = courtEntry{ClosedReason: c.ClosedReason, Live: live, Next: pick, NextNote: note}
	}

	for _, c := range data.Courts {
		if c.Live != nil || c.BusyElsewhere {
			continue
		}
		var idleReason, nextNote *string
		var next *boardMatch
		offered, hasOffer := offerByCourt[c.ID]
		switch {
		case c.Closed:
			// Nothing to say: the card already prints why.
		case hasOffer:
			// The flow should have placed this. It did not, so the board offers it.
			m := offered
			next = &m
		case len(data.Queue) > 0:
			idleReason = strp("Everyone who could play next is already on a court")
			// Not the raw head of the queue: a busy court may already be
			// promised it, and the same pair cannot be next on two courts.
			for i := range data.Queue {
				if !promised[data.Queue[i].ID] {
					m := data.Queue[i]
					next = &m
					promised[m.ID] = true
					break
				}
			}
			if paused {
				idleReason = nil
			}
		case len(data.Waiting) > 0:
			nextNote = strp(waitingNote(c.ID))
		case data.Remaining == 0:
			idleReason = strp("Every " + categoryName + " match has been played")
		case len(liveCourts) > 0:
			nextNote = strp("Nothing left for this court")
		}
		entry := courtEntry{ClosedReason: c.ClosedReason, Next: next, NextNote: nextNote, IdleReason: idleReason}
		if hasOffer && !paused {
			m := offered
			entry.Offer = &m
		}
		out[c.ID] = entry
	}
	return out
}

// possessive — "Court 1’s result", "Court 1 and Court 2".
func possessive(names []string) string {
	if len(names) == 0 {
		return "’s result"
	}
	if len(names) == 1 {
		return names[0] + "’s result"
	}
	return strings.Join(names[:len(names)-1], ", ") + " and " + names[len(names)-1]
}

// couldUseAnotherCourt — would one more court actually get a match on? Only
// when every court the tournament holds is busy AND a match is waiting whose
// players are all free. "5 to play and a court sitting empty" used to show with
// four pairs on two courts — all eight players already playing.
func couldUseAnotherCourt(data *boardData) bool {
	for _, c := range data.Courts {
		if c.Live == nil && !c.Closed && !c.BusyElsewhere {
			return false
		}
	}
	widened := *data
	widened.Courts = append(append([]boardCourt(nil), data.Courts...), boardCourt{ID: "another"})
	return len(offersForFreeCourts(&widened, nil)) > 0
}

// ── the venue-wide board ──────────────────────────────────────────────────

type wireMatch struct {
	ID             string  `json:"id"`
	RoundName      *string `json:"roundName"`
	NameA          *string `json:"nameA"`
	NameB          *string `json:"nameB"`
	OverrunMinutes *int    `json:"overrunMinutes"`
}

func toWire(m *boardMatch) *wireMatch {
	if m == nil {
		return nil
	}
	return &wireMatch{ID: m.ID, RoundName: m.RoundName, NameA: m.NameA, NameB: m.NameB, OverrunMinutes: m.OverrunMinutes}
}

type wireVenueTournament struct {
	ID           string   `json:"id"`
	Slug         string   `json:"slug"`
	Name         string   `json:"name"`
	CategoryName string   `json:"categoryName"`
	ShortName    string   `json:"shortName"`
	Running      bool     `json:"running"`
	Paused       *string  `json:"paused"`
	Played       int      `json:"played"`
	Total        int      `json:"total"`
	ToPlay       int      `json:"toPlay"`
	Remaining    int      `json:"remaining"`
	FinishAt     *string  `json:"finishAt"`
	CourtIDs     []string `json:"courtIds"`
}

type wireVenueCourt struct {
	ID           string               `json:"id"`
	Name         string               `json:"name"`
	ColorKey     string               `json:"colorKey"`
	Tournament   *wireVenueTournament `json:"tournament"`
	ClosedReason *string              `json:"closedReason"`
	Live         *wireMatch           `json:"live"`
	Next         *wireMatch           `json:"next"`
	NextNote     *string              `json:"nextNote"`
	Offer        *wireMatch           `json:"offer"`
	IdleReason   *string              `json:"idleReason"`
}

type venueBoardOut struct {
	Now         string                 `json:"now"`
	Tournaments []*wireVenueTournament `json:"tournaments"`
	Courts      []wireVenueCourt       `json:"courts"`
	LiveCount   int                    `json:"liveCount"`
	Wants       *wireVenueTournament   `json:"wants"`
}

// venueBoard is every court at the venue, one entry each, in venue order,
// across every tournament on today. Read-only: the auto-flow runs at the
// writes, never while a page renders.
func venueBoard(ctx context.Context, d *core.Deps) (*venueBoardOut, error) {
	courtRows, err := store.VenueCourts(ctx, d.DB, d.Venue.ID, true)
	if err != nil {
		return nil, err
	}
	todays, err := todaysTournaments(ctx, d.DB, d)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(todays))
	for _, t := range todays {
		ids = append(ids, t.ID)
	}
	held, err := heldCourts(ctx, d.DB, ids)
	if err != nil {
		return nil, err
	}

	out := &venueBoardOut{Now: d.Now().UTC().Format(time.RFC3339Nano), Courts: []wireVenueCourt{}, Tournaments: []*wireVenueTournament{}}
	holder := map[string]*wireVenueTournament{}
	perCourt := map[string]courtEntry{}
	var wants *wireVenueTournament
	wantsToPlay := -1

	for _, t := range todays {
		categoryName := engine.CategoryName(t.Gender, t.Discipline)
		vt := &wireVenueTournament{
			ID: t.ID, Slug: t.Slug, Name: t.Name, CategoryName: categoryName,
			ShortName: shortCategory(categoryName), Running: t.Status == "live",
			CourtIDs: held[t.ID],
		}
		if vt.CourtIDs == nil {
			vt.CourtIDs = []string{}
		}
		if t.PausedAt != nil {
			note := "Paused"
			if t.PauseNote != nil && *t.PauseNote != "" {
				note = *t.PauseNote
			}
			vt.Paused = &note
		}
		if t.Status == "live" {
			data, err := loadBoard(ctx, d.DB, d, t)
			if err != nil {
				return nil, err
			}
			vt.Played = data.Played
			vt.Remaining = data.Remaining
			vt.Total = data.Played + data.Remaining
			vt.ToPlay = len(data.Queue) + len(data.Waiting)
			vt.FinishAt = iso(data.FinishAt)
			for courtID, entry := range nextByCourt(data, categoryName, vt.Paused != nil) {
				perCourt[courtID] = entry
			}
			if vt.ToPlay >= 3 && vt.Paused == nil && couldUseAnotherCourt(data) && vt.ToPlay > wantsToPlay {
				wants = vt
				wantsToPlay = vt.ToPlay
			}
		}
		out.Tournaments = append(out.Tournaments, vt)
		for _, c := range vt.CourtIDs {
			holder[c] = vt
		}
	}

	for _, c := range courtRows {
		entry := perCourt[c.ID]
		vc := wireVenueCourt{
			ID: c.ID, Name: c.Name, ColorKey: c.ColorKey, Tournament: holder[c.ID],
			ClosedReason: entry.ClosedReason, Live: toWire(entry.Live), Next: toWire(entry.Next),
			NextNote: entry.NextNote, Offer: toWire(entry.Offer), IdleReason: entry.IdleReason,
		}
		if vc.Live != nil {
			out.LiveCount++
		}
		out.Courts = append(out.Courts, vc)
	}
	out.Wants = wants
	return out, nil
}

// venueVersion is the one number the board polls. It moves when anything
// board-visible moves in any of today's tournaments, when the set of them
// changes, and when the venue's courts change — the board draws a card per
// court, so a court added or renamed has to move it too.
func venueVersion(ctx context.Context, q core.Querier, d *core.Deps) (string, error) {
	todays, err := todaysTournaments(ctx, q, d)
	if err != nil {
		return "", err
	}
	sum := 0
	for _, t := range todays {
		sum += t.Version
	}
	courts, err := courtSignature(ctx, q, d.Venue.ID)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%d:%d:%s", len(todays), sum, courts), nil
}

// ── the RPCs ──────────────────────────────────────────────────────────────

type matchIn struct {
	MatchID string `json:"matchId"`
	CourtID string `json:"courtId"`
	Later   bool   `json:"later"`
}

type okRedirect struct {
	OK       bool    `json:"ok"`
	Redirect string  `json:"redirect,omitempty"`
	Error    string  `json:"error,omitempty"`
	Fix      *string `json:"fix,omitempty"`
}

type moveOptionsOut struct {
	Match struct {
		ID        string  `json:"id"`
		NameA     *string `json:"nameA"`
		NameB     *string `json:"nameB"`
		CourtName *string `json:"courtName"`
	} `json:"match"`
	Tournament struct {
		Slug         string `json:"slug"`
		CategoryName string `json:"categoryName"`
	} `json:"tournament"`
	Courts []moveOptionCourt `json:"courts"`
}

type moveOptionCourt struct {
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	ColorKey     string          `json:"colorKey"`
	Busy         *moveOptionBusy `json:"busy"`
	ClosedReason *string         `json:"closedReason"`
}

type moveOptionBusy struct {
	NameA   *string `json:"nameA"`
	NameB   *string `json:"nameB"`
	Minutes int     `json:"minutes"`
}

func registerBoard(reg *rpc.Registry, d *core.Deps) {
	rpc.Register(reg, "board.venueBoard", rpc.Organiser,
		func(ctx context.Context, _ struct{}) (*venueBoardOut, error) {
			return venueBoard(ctx, d)
		})

	rpc.Register(reg, "board.moveOptions", rpc.Organiser,
		func(ctx context.Context, in matchIn) (*moveOptionsOut, error) {
			match, err := store.MatchByID(ctx, d.DB, in.MatchID)
			if err != nil || match.Status != "live" {
				// A match with nothing to move; the board says where it is.
				return nil, rpc.NotFound("That match isn’t on a court.")
			}
			t, err := store.TournamentByID(ctx, d.DB, d.Venue.ID, match.TournamentID)
			if err != nil {
				return nil, rpc.NotFound("That match isn’t on a court.")
			}
			data, err := loadBoard(ctx, d.DB, d, t)
			if err != nil {
				return nil, err
			}
			var here *boardCourt
			for i := range data.Courts {
				if match.CourtID != nil && data.Courts[i].ID == *match.CourtID {
					here = &data.Courts[i]
				}
			}
			if here == nil || here.Live == nil {
				return nil, rpc.NotFound("That match isn’t on a court.")
			}
			now := d.Now()
			out := &moveOptionsOut{Courts: []moveOptionCourt{}}
			out.Match.ID = here.Live.ID
			out.Match.NameA = here.Live.NameA
			out.Match.NameB = here.Live.NameB
			out.Match.CourtName = strp(here.Name)
			out.Tournament.Slug = t.Slug
			out.Tournament.CategoryName = engine.CategoryName(t.Gender, t.Discipline)
			for _, c := range data.Courts {
				if c.ID == here.ID {
					continue
				}
				mc := moveOptionCourt{ID: c.ID, Name: c.Name, ColorKey: c.ColorKey, ClosedReason: c.ClosedReason}
				if c.Live != nil {
					minutes := 0
					if c.Live.StartedAt != nil {
						minutes = minutesSince(*c.Live.StartedAt, now)
					}
					mc.Busy = &moveOptionBusy{NameA: c.Live.NameA, NameB: c.Live.NameB, Minutes: minutes}
				}
				out.Courts = append(out.Courts, mc)
			}
			return out, nil
		})

	rpc.Register(reg, "board.sendToCourt", rpc.Organiser,
		func(ctx context.Context, in matchIn) (okRedirect, error) {
			var out okRedirect
			err := d.Tx(ctx, func(tx *sql.Tx) error {
				match, err := store.MatchByID(ctx, tx, in.MatchID)
				if err != nil {
					out = okRedirect{Error: "That match no longer exists."}
					return nil
				}
				t, err := store.TournamentByIDForUpdate(ctx, tx, d.Venue.ID, match.TournamentID)
				if err != nil {
					out = okRedirect{Error: "That match no longer exists."}
					return nil
				}
				refusal, err := sendToCourt(ctx, tx, d, t, in.MatchID, in.CourtID)
				if err != nil {
					return err
				}
				if refusal != "" {
					out = okRedirect{Error: refusal}
					return nil
				}
				if err := flowTournament(ctx, tx, d, t.ID, nil); err != nil {
					return err
				}
				out = okRedirect{OK: true, Redirect: "/admin/live"}
				return audit(ctx, tx, "match.send_to_court", "match", in.MatchID, "",
					map[string]any{"courtId": in.CourtID})
			})
			return out, err
		})

	rpc.Register(reg, "board.moveMatch", rpc.Organiser,
		func(ctx context.Context, in matchIn) (okRedirect, error) {
			var out okRedirect
			err := d.Tx(ctx, func(tx *sql.Tx) error {
				match, err := store.MatchByID(ctx, tx, in.MatchID)
				if err != nil {
					out = okRedirect{Error: "That match no longer exists."}
					return nil
				}
				if _, err := store.TournamentByIDForUpdate(ctx, tx, d.Venue.ID, match.TournamentID); err != nil {
					out = okRedirect{Error: "That match no longer exists."}
					return nil
				}
				refusal, err := moveMatch(ctx, tx, d, in.MatchID, in.CourtID)
				if err != nil {
					return err
				}
				if refusal != "" {
					out = okRedirect{Error: refusal}
					return nil
				}
				// The court it left is free now: the next match goes on it.
				if err := flowVenue(ctx, tx, d, match.TournamentID, nil); err != nil {
					return err
				}
				out = okRedirect{OK: true, Redirect: "/admin/live"}
				return audit(ctx, tx, "match.moved", "match", in.MatchID, "",
					map[string]any{"courtId": in.CourtID})
			})
			return out, err
		})

	rpc.Register(reg, "board.clearCourt", rpc.Organiser,
		func(ctx context.Context, in matchIn) (okRedirect, error) {
			var out okRedirect
			err := d.Tx(ctx, func(tx *sql.Tx) error {
				match, err := store.MatchByID(ctx, tx, in.MatchID)
				if err != nil {
					out = okRedirect{Error: "That match no longer exists."}
					return nil
				}
				if _, err := store.TournamentByIDForUpdate(ctx, tx, d.Venue.ID, match.TournamentID); err != nil {
					out = okRedirect{Error: "That match no longer exists."}
					return nil
				}
				refusal, err := clearCourt(ctx, tx, d, in.MatchID, in.Later)
				if err != nil {
					return err
				}
				if refusal != "" {
					out = okRedirect{Error: refusal}
					return nil
				}
				// "Play it later" means the court it left fills with the NEXT
				// match, not this one.
				var skip map[string]bool
				if in.Later {
					skip = map[string]bool{in.MatchID: true}
				}
				if err := flowVenue(ctx, tx, d, match.TournamentID, skip); err != nil {
					return err
				}
				out = okRedirect{OK: true, Redirect: "/admin/live"}
				return audit(ctx, tx, "match.clear_court", "match", in.MatchID, "", nil)
			})
			return out, err
		})
}

// audit writes the row that says who did what, with the signed-in organiser
// where there is one.
func audit(ctx context.Context, q core.Querier, action, entity, entityID, reason string, details any) error {
	userID := ""
	if u := rpc.UserFrom(ctx); u != nil {
		userID = u.ID
	}
	return core.Audit(ctx, q, userID, action, entity, entityID, reason, details)
}
