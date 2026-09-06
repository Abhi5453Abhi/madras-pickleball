package setup

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"strings"

	"mpb/internal/core"
	"mpb/internal/engine"
	"mpb/internal/ids"
	"mpb/internal/rpc"
	"mpb/internal/store"
)

// Registration — SPEC v4.
//
// One link per tournament, dropped in the WhatsApp group. A player types their
// name, a phone number if they like, and who they want to play with, and they
// are on the list — there is no queue for the organiser to wave people
// through. The organiser adds the ones who phoned, removes the ones who cannot
// make it, and closes the link when the list is full.
//
// The one thing the machine cannot decide is whether "Ravi S" is Ravi Shankar.
// It says so, on the row, and the organiser answers with one tap.

// kindSignup keys the guard in front of the two public RPCs.
const kindSignup = "signup"

// crockford is the sign-up link's alphabet (no I, L, O, U).
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

type tokenOut struct {
	Token string `json:"token"`
}

type rosterEntryOut struct {
	PlayerID    string     `json:"playerId"`
	Name        string     `json:"name"`
	Source      string     `json:"source"`
	Partner     *string    `json:"partner"`
	DuplicateOf *duplicate `json:"duplicateOf"`
}

type duplicate struct {
	PlayerID string `json:"playerId"`
	Name     string `json:"name"`
}

type addByHandIn struct {
	TournamentID string `json:"tournamentId"`
	Text         string `json:"text"`
}

type addByHandOut struct {
	OK      bool     `json:"ok"`
	Added   int      `json:"added"`
	Skipped int      `json:"skipped"`
	Flagged []string `json:"flagged"`
	Error   string   `json:"error,omitempty"`
}

type playerIn struct {
	TournamentID string `json:"tournamentId"`
	PlayerID     string `json:"playerId"`
}

type mergeIn struct {
	TournamentID string `json:"tournamentId"`
	KeepID       string `json:"keepId"`
	DropID       string `json:"dropId"`
}

type resolveTokenIn struct {
	Token string `json:"token"`
}

type resolveTokenOut struct {
	Tournament struct {
		Name string `json:"name"`
		Day  string `json:"day"`
	} `json:"tournament"`
	Discipline string `json:"discipline"`
	Closed     bool   `json:"closed"`
}

type submitIn struct {
	Token       string  `json:"token"`
	Name        string  `json:"name"`
	Phone       *string `json:"phone"`
	PartnerName *string `json:"partnerName"`
	DeviceID    *string `json:"deviceId"`
}

type submitOut struct {
	OK        bool   `json:"ok"`
	AlreadyIn bool   `json:"alreadyIn"`
	Error     string `json:"error,omitempty"`
}

func registerRegistration(reg *rpc.Registry, d *core.Deps) {
	rpc.Register(reg, "registration.ensureRegistrationLink", rpc.Organiser,
		func(ctx context.Context, in tournamentIDIn) (*tokenOut, error) {
			return ensureRegistrationLink(ctx, d, in)
		})

	rpc.Register(reg, "registration.listRoster", rpc.Organiser,
		func(ctx context.Context, in tournamentIDIn) ([]rosterEntryOut, error) { return listRoster(ctx, d, in) })

	rpc.Register(reg, "registration.addByHand", rpc.Organiser,
		func(ctx context.Context, in addByHandIn) (addByHandOut, error) { return addByHand(ctx, d, in) })

	rpc.Register(reg, "registration.removePlayer", rpc.Organiser,
		func(ctx context.Context, in playerIn) (noteOut, error) { return removePlayer(ctx, d, in) })

	rpc.Register(reg, "registration.mergePlayers", rpc.Organiser,
		func(ctx context.Context, in mergeIn) (noteOut, error) { return mergePlayers(ctx, d, in) })

	rpc.Register(reg, "registration.keepBoth", rpc.Organiser,
		func(ctx context.Context, in playerIn) (okOut, error) { return keepBoth(ctx, d, in) })

	// The two public ones: no cookie is read, and no phone number goes out.
	rpc.Register(reg, "registration.resolveRegistrationToken", rpc.Public,
		func(ctx context.Context, in resolveTokenIn) (resolveTokenOut, error) {
			return resolveRegistrationToken(ctx, d, in)
		})

	rpc.Register(reg, "registration.submitRegistration", rpc.Public,
		func(ctx context.Context, in submitIn) (submitOut, error) { return submitRegistration(ctx, d, in) })
}

// ── the link ──────────────────────────────────────────────────────────────

// normalizeCrockford is the half people forget: O reads as 0, I and L read as
// 1, and case and separators don't count. Someone typing a link off a WhatsApp
// screenshot still types O for 0.
func normalizeCrockford(input string) string {
	s := strings.ToUpper(strings.TrimSpace(input))
	var b strings.Builder
	for _, r := range s {
		switch r {
		case ' ', '\t', '\n', '-':
		case 'O':
			b.WriteRune('0')
		case 'I', 'L':
			b.WriteRune('1')
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// tokenFromID derives the link from the row's own random id, so the organiser's
// screen can show it again without ever storing the token itself.
func tokenFromID(id string) string {
	hex := core.Sha256Hex("registration-link:" + id)
	var out strings.Builder
	for i := 0; i < 10; i++ {
		n, _ := strconv.ParseInt(hex[i*2:i*2+2], 16, 32)
		out.WriteByte(crockford[n%32])
	}
	s := out.String()
	return s[:5] + "-" + s[5:]
}

// newRegistrationToken revokes whatever link the tournament had and issues
// one. Both halves land together or not at all.
func newRegistrationToken(ctx context.Context, tx *sql.Tx, tournamentID string) (string, error) {
	if _, err := tx.ExecContext(ctx,
		`update registration_tokens set revoked_at = now() where tournament_id = $1 and revoked_at is null`,
		tournamentID); err != nil {
		return "", err
	}
	id := ids.New("rt")
	raw := tokenFromID(id)
	if _, err := tx.ExecContext(ctx,
		`insert into registration_tokens (id, tournament_id, token_hash, token_prefix) values ($1,$2,$3,$4)`,
		id, tournamentID, core.Sha256Hex(normalizeCrockford(raw)), raw[:5]); err != nil {
		return "", err
	}
	return raw, nil
}

func currentToken(ctx context.Context, q core.Querier, tournamentID string) (string, error) {
	var id, hash string
	err := q.QueryRowContext(ctx,
		`select id, token_hash from registration_tokens where tournament_id = $1 and revoked_at is null
		 order by created_at desc limit 1`, tournamentID).Scan(&id, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	raw := tokenFromID(id)
	// A row issued some other way cannot be shown again; it is replaced.
	if core.Sha256Hex(normalizeCrockford(raw)) != hash {
		return "", nil
	}
	return raw, nil
}

// dayHasPassed — the link has no expiry column: it stops working by the
// calendar, at the end of the tournament's day at the venue.
func dayHasPassed(d *core.Deps, t *store.Tournament) bool {
	return d.Now().After(core.DayEnd(t.Day))
}

func ensureRegistrationLink(ctx context.Context, d *core.Deps, in tournamentIDIn) (*tokenOut, error) {
	t, err := mustTournament(ctx, d, d.DB, in.TournamentID)
	if err != nil {
		return nil, err
	}
	// Once the day has gone there is nothing to sign up for: issuing a link
	// that has already stopped working, on every render, is just churn.
	if dayHasPassed(d, t) {
		return nil, nil
	}
	raw, err := currentToken(ctx, d.DB, t.ID)
	if err != nil {
		return nil, err
	}
	if raw != "" {
		return &tokenOut{Token: raw}, nil
	}
	err = d.Tx(ctx, func(tx *sql.Tx) error {
		locked, err := lockTournament(ctx, tx, d, t.ID)
		if err != nil {
			return err
		}
		// Another tab may have made one between the read and the lock.
		raw, err = currentToken(ctx, tx, locked.ID)
		if err != nil || raw != "" {
			return err
		}
		raw, err = newRegistrationToken(ctx, tx, locked.ID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return &tokenOut{Token: raw}, nil
}

// ── the list ──────────────────────────────────────────────────────────────

// flagsFor is player id → the earlier person they were flagged against.
func flagsFor(ctx context.Context, q core.Querier, tournamentID string) (map[string]string, error) {
	rows, err := q.QueryContext(ctx,
		`select player_id, matched_player_id from pending_registrations
		 where tournament_id = $1 and status = 'pending'`, tournamentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var playerID, matched string
		if err := rows.Scan(&playerID, &matched); err != nil {
			return nil, err
		}
		out[playerID] = matched
	}
	return out, rows.Err()
}

func listRoster(ctx context.Context, d *core.Deps, in tournamentIDIn) ([]rosterEntryOut, error) {
	t, err := mustTournament(ctx, d, d.DB, in.TournamentID)
	if err != nil {
		return nil, err
	}
	roster, err := store.Roster(ctx, d.DB, t.ID)
	if err != nil {
		return nil, err
	}
	flags, err := flagsFor(ctx, d.DB, t.ID)
	if err != nil {
		return nil, err
	}
	byID := map[string]store.TournamentPlayer{}
	for _, r := range roster {
		byID[r.Player.ID] = r
	}
	out := make([]rosterEntryOut, 0, len(roster))
	for _, r := range roster {
		e := rosterEntryOut{PlayerID: r.Player.ID, Name: r.Player.Name, Source: r.Source}
		if r.PartnerPlayerID != nil {
			if named, ok := byID[*r.PartnerPlayerID]; ok {
				name := named.Player.Name
				e.Partner = &name
			}
		}
		if e.Partner == nil {
			e.Partner = r.PartnerWish
		}
		// A flag pointing at somebody who has since left says nothing to
		// anybody, so it is simply not shown.
		if matched, ok := flags[r.Player.ID]; ok {
			if other, ok := byID[matched]; ok {
				e.DuplicateOf = &duplicate{PlayerID: other.Player.ID, Name: other.Player.Name}
			}
		}
		out = append(out, e)
	}
	return out, nil
}

// ── adding ────────────────────────────────────────────────────────────────

type addInput struct {
	name        string
	phone       string
	partnerWish string
	source      string // link | hand
}

type addResult struct {
	playerID string
	// flagged is somebody already on the list who looks like this person.
	flagged *duplicate
	// refusal is a sentence for the person who typed it, or "".
	refusal string
}

// addPlayer puts one person on the list, whichever way they arrived.
//
// Who they are in the venue's book of players: the phone number if it is
// known, otherwise a player with exactly this name who is not already on this
// list and does not carry a different number, otherwise somebody new. If they
// look like somebody already on the list they still go on — the organiser is
// the one who knows — with a flag for the organiser to settle.
//
// Partner wishes resolve both ways: theirs to whoever on the list has that
// name, and anyone who had already named THEM gets the pointer filled in now.
func addPlayer(ctx context.Context, tx *sql.Tx, d *core.Deps, t *store.Tournament, in addInput) (addResult, error) {
	name := strings.TrimSpace(in.name)
	if len([]rune(name)) < 2 {
		return addResult{refusal: "Put a name in."}, nil
	}
	if len([]rune(name)) > 60 {
		return addResult{refusal: "That name is too long."}, nil
	}
	nameKey := engine.NormalizeName(name)
	if nameKey == "" {
		return addResult{refusal: "That doesn’t look like a name."}, nil
	}
	phone := strings.TrimSpace(in.phone)
	phoneKey := engine.NormalizePhone(phone)
	if phone != "" && phoneKey == "" {
		return addResult{refusal: "That phone number doesn’t look right — ten digits, or leave it blank."}, nil
	}
	partnerWish := cleanText(in.partnerWish, 60)
	partnerKey := ""
	if partnerWish != "" {
		partnerKey = engine.NormalizeName(partnerWish)
	}

	roster, err := store.Roster(ctx, tx, t.ID)
	if err != nil {
		return addResult{}, err
	}
	onList := map[string]bool{}
	for _, r := range roster {
		onList[r.Player.ID] = true
	}

	playerID := ""
	// A number already on somebody else's record is kept as text only: the
	// same number under a different name must not silently become last
	// month's person, or anyone with the link could learn who a number
	// belongs to.
	phoneTaken := false
	if phoneKey != "" {
		var id, existing string
		err := tx.QueryRowContext(ctx,
			`select id, name from players where venue_id = $1 and phone_key = $2 and deleted_at is null
			 order by created_at limit 1`, d.Venue.ID, phoneKey).Scan(&id, &existing)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return addResult{}, err
		}
		if err == nil {
			sameName := engine.NormalizeName(existing) == nameKey
			if sameName && onList[id] {
				return addResult{refusal: existing + " is already on the list."}, nil
			}
			if sameName {
				playerID = id
			} else {
				phoneTaken = true
			}
		}
	}
	if playerID == "" {
		rows, err := tx.QueryContext(ctx,
			`select id, phone_key from players where venue_id = $1 and name_key = $2 and deleted_at is null
			 order by created_at`, d.Venue.ID, nameKey)
		if err != nil {
			return addResult{}, err
		}
		for rows.Next() {
			var id string
			var pk sql.NullString
			if err := rows.Scan(&id, &pk); err != nil {
				rows.Close()
				return addResult{}, err
			}
			if !onList[id] && (phoneKey == "" || !pk.Valid) {
				playerID = id
				break
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return addResult{}, err
		}
	}
	isNew := playerID == ""
	id := playerID
	if isNew {
		id = ids.New("ply")
	}

	var flagged *duplicate
	for _, r := range roster {
		if engine.LooksLikeSamePerson(r.Player.NameKey, nameKey) {
			flagged = &duplicate{PlayerID: r.Player.ID, Name: r.Player.Name}
			break
		}
	}
	var partnerPlayerID any
	if partnerKey != "" && partnerKey != nameKey {
		for _, r := range roster {
			if r.Player.NameKey == partnerKey {
				partnerPlayerID = r.Player.ID
				break
			}
		}
	}
	// Anyone who had already named THEM now points at a real person.
	var namedMe []string
	for _, r := range roster {
		if r.PartnerPlayerID == nil && r.PartnerWish != nil && engine.NormalizeName(*r.PartnerWish) == nameKey {
			namedMe = append(namedMe, r.ID)
		}
	}

	if isNew {
		var storedPhone, storedKey any
		if phone != "" {
			storedPhone = phone
		}
		if phoneKey != "" && !phoneTaken {
			storedKey = phoneKey
		}
		// clock_timestamp(), not the column's default: now() is the
		// TRANSACTION's time, so a pasted list of forty names would land on one
		// instant and "the order they arrived" would come back shuffled.
		if _, err := tx.ExecContext(ctx,
			`insert into players (id, venue_id, name, name_key, phone, phone_key, created_at)
			 values ($1,$2,$3,$4,$5,$6, clock_timestamp())`,
			id, d.Venue.ID, name, nameKey, storedPhone, storedKey); err != nil {
			return addResult{}, err
		}
	} else if phoneKey != "" && !phoneTaken {
		// A number we did not have. Safe to set: nobody else carries it, or
		// the phone lookup above would have found them.
		if _, err := tx.ExecContext(ctx,
			`update players set phone = $2, phone_key = $3 where id = $1 and phone_key is null`,
			id, phone, phoneKey); err != nil {
			return addResult{}, err
		}
	}
	if _, err := tx.ExecContext(ctx, `
		insert into tournament_players (id, tournament_id, player_id, source, partner_wish, partner_player_id, created_at)
		values ($1,$2,$3,$4,$5,$6, clock_timestamp())`,
		ids.New("tp"), t.ID, id, in.source, nullable(partnerWish), partnerPlayerID); err != nil {
		return addResult{}, err
	}
	for _, tpID := range namedMe {
		if _, err := tx.ExecContext(ctx,
			`update tournament_players set partner_player_id = $2 where id = $1`, tpID, id); err != nil {
			return addResult{}, err
		}
	}
	if flagged != nil {
		// The whole of the duplicate flag: a row the organiser has to answer.
		if _, err := tx.ExecContext(ctx, `
			insert into pending_registrations (id, tournament_id, player_id, matched_player_id, status)
			values ($1,$2,$3,$4,'pending')`,
			ids.New("reg"), t.ID, id, flagged.PlayerID); err != nil {
			return addResult{}, err
		}
	}
	return addResult{playerID: id, flagged: flagged}, core.Bump(ctx, tx, t.ID)
}

// addByHand is the organiser's box: one line is a person, a paste is the group
// chat's list. Names already on the list are skipped and counted, not refused
// — the paste is last week's list plus three new people.
func addByHand(ctx context.Context, d *core.Deps, in addByHandIn) (addByHandOut, error) {
	out := addByHandOut{Flagged: []string{}}
	err := d.Tx(ctx, func(tx *sql.Tx) error {
		t, err := lockTournament(ctx, tx, d, in.TournamentID)
		if err != nil {
			return err
		}
		if t.Status == "completed" {
			out = addByHandOut{Flagged: []string{}, Error: "That tournament has finished."}
			return nil
		}

		if strings.Contains(strings.TrimSpace(in.Text), "\n") {
			rows := engine.ParsePlayerList(cutRunes(in.Text, 4000))
			var named []engine.ParsedRow
			for _, r := range rows {
				if r.Name != "" {
					named = append(named, r)
				}
			}
			if len(named) == 0 {
				out = addByHandOut{Flagged: []string{}, Error: "Put a name in — the phone number is optional."}
				return nil
			}
			added, skipped := 0, 0
			flagged := []string{}
			for _, row := range named {
				on, err := nameOnList(ctx, tx, t.ID, engine.NormalizeName(row.Name))
				if err != nil {
					return err
				}
				if on {
					skipped++
					continue
				}
				res, err := addPlayer(ctx, tx, d, t, addInput{name: row.Name, phone: row.Phone, source: "hand"})
				if err != nil {
					return err
				}
				if res.refusal != "" {
					out = addByHandOut{Flagged: []string{}, Error: res.refusal}
					return errRollback
				}
				added++
				if res.flagged != nil {
					flagged = append(flagged, row.Name)
				}
			}
			if added == 0 {
				out = addByHandOut{Flagged: []string{}, Error: "Everyone in that list is already on it."}
				return nil
			}
			if err := core.Audit(ctx, tx, actor(ctx), "registration.pasted_list", "tournament", t.ID, "",
				map[string]any{"added": added, "skipped": skipped, "flagged": flagged}); err != nil {
				return err
			}
			out = addByHandOut{OK: true, Added: added, Skipped: skipped, Flagged: flagged}
			return nil
		}

		// One line: "Name 98400 12345", the phone optional.
		rows := engine.ParsePlayerList(cutRunes(in.Text, 120))
		if len(rows) == 0 || rows[0].Name == "" {
			out = addByHandOut{Flagged: []string{}, Error: "Put a name in — the phone number is optional."}
			return nil
		}
		row := rows[0]
		// Typing a name that is already there is a slip, not a second person.
		nameKey := engine.NormalizeName(row.Name)
		on, err := nameOnList(ctx, tx, t.ID, nameKey)
		if err != nil {
			return err
		}
		if on {
			name, err := listedNameFor(ctx, tx, t.ID, nameKey)
			if err != nil {
				return err
			}
			out = addByHandOut{Flagged: []string{}, Error: name + " is already on the list."}
			return nil
		}
		res, err := addPlayer(ctx, tx, d, t, addInput{name: row.Name, phone: row.Phone, source: "hand"})
		if err != nil {
			return err
		}
		if res.refusal != "" {
			out = addByHandOut{Flagged: []string{}, Error: res.refusal}
			return nil
		}
		if err := core.Audit(ctx, tx, actor(ctx), "registration.added_by_hand", "player", res.playerID, "", nil); err != nil {
			return err
		}
		flagged := []string{}
		if res.flagged != nil {
			flagged = append(flagged, row.Name)
		}
		out = addByHandOut{OK: true, Added: 1, Flagged: flagged}
		return nil
	})
	if err != nil && !errors.Is(err, errRollback) {
		return addByHandOut{}, err
	}
	return out, nil
}

// errRollback throws away a half-applied paste while keeping the sentence
// that explains it.
var errRollback = errors.New("setup: rolled back on purpose")

func cutRunes(s string, max int) string {
	r := []rune(s)
	if len(r) > max {
		return string(r[:max])
	}
	return s
}

func nameOnList(ctx context.Context, q core.Querier, tournamentID, nameKey string) (bool, error) {
	if nameKey == "" {
		return false, nil
	}
	var id string
	err := q.QueryRowContext(ctx, `
		select p.id from tournament_players tp join players p on p.id = tp.player_id
		where tp.tournament_id = $1 and p.name_key = $2 limit 1`, tournamentID, nameKey).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func listedNameFor(ctx context.Context, q core.Querier, tournamentID, nameKey string) (string, error) {
	var name string
	err := q.QueryRowContext(ctx, `
		select p.name from tournament_players tp join players p on p.id = tp.player_id
		where tp.tournament_id = $1 and p.name_key = $2 limit 1`, tournamentID, nameKey).Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return name, err
}

// ── removing and merging ──────────────────────────────────────────────────

type pairInfo struct {
	teamID     string
	name       string
	onSchedule bool
	hasResult  bool
}

// pairOf is the pair this player is in, and whether it is too late to take it
// apart.
func pairOf(ctx context.Context, q core.Querier, tournamentID, playerID string) (*pairInfo, error) {
	var p pairInfo
	err := q.QueryRowContext(ctx, `
		select t.id, t.name from team_players tp join teams t on t.id = tp.team_id
		where tp.player_id = $1 and t.tournament_id = $2 limit 1`, playerID, tournamentID).Scan(&p.teamID, &p.name)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var n, played int
	if err := q.QueryRowContext(ctx, `
		select count(*)::int, count(*) filter (where result_state <> 'none')::int from matches
		where tournament_id = $1 and (team_a_id = $2 or team_b_id = $2 or winner_team_id = $2 or retired_team_id = $2)`,
		tournamentID, p.teamID).Scan(&n, &played); err != nil {
		return nil, err
	}
	p.onSchedule = n > 0
	p.hasResult = played > 0
	return &p, nil
}

func tooLate(name string, p *pairInfo) string {
	if p == nil {
		return ""
	}
	if p.hasResult {
		return name + " is in " + p.name + ", and that pair has already played. Sort it out under More."
	}
	if p.onSchedule {
		return name + " is in " + p.name + ", which is on the schedule. Split the pair first, then make the schedule again."
	}
	return ""
}

// settleOrphanFlags closes flags that no longer point at anybody — the person
// they looked like has gone.
func settleOrphanFlags(ctx context.Context, tx *sql.Tx, tournamentID string) error {
	roster, err := store.Roster(ctx, tx, tournamentID)
	if err != nil {
		return err
	}
	on := map[string]bool{}
	for _, r := range roster {
		on[r.Player.ID] = true
	}
	flags, err := flagsFor(ctx, tx, tournamentID)
	if err != nil {
		return err
	}
	for playerID, matched := range flags {
		if on[playerID] && on[matched] {
			continue
		}
		if _, err := tx.ExecContext(ctx, `
			update pending_registrations set status = 'kept', reviewed_at = now()
			where tournament_id = $1 and player_id = $2 and status = 'pending'`, tournamentID, playerID); err != nil {
			return err
		}
	}
	return nil
}

func removePlayer(ctx context.Context, d *core.Deps, in playerIn) (noteOut, error) {
	var out noteOut
	err := d.Tx(ctx, func(tx *sql.Tx) error {
		t, err := lockTournament(ctx, tx, d, in.TournamentID)
		if err != nil {
			return err
		}
		roster, err := store.Roster(ctx, tx, t.ID)
		if err != nil {
			return err
		}
		var row *store.TournamentPlayer
		for i := range roster {
			if roster[i].Player.ID == in.PlayerID {
				row = &roster[i]
			}
		}
		if row == nil {
			out = refuse("They are not on the list any more.")
			return nil
		}
		pair, err := pairOf(ctx, tx, t.ID, in.PlayerID)
		if err != nil {
			return err
		}
		// A pair that has played is not ours to touch from here.
		if late := tooLate(row.Player.Name, pair); late != "" {
			out = refuse(late)
			return nil
		}
		if pair != nil {
			if _, err := tx.ExecContext(ctx, `delete from teams where id = $1`, pair.teamID); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `
			update tournament_players set partner_player_id = null
			where tournament_id = $1 and partner_player_id = $2`, t.ID, in.PlayerID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `delete from tournament_players where id = $1`, row.ID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			delete from pending_registrations where tournament_id = $1 and player_id = $2`,
			t.ID, in.PlayerID); err != nil {
			return err
		}
		if err := settleOrphanFlags(ctx, tx, t.ID); err != nil {
			return err
		}
		if err := core.Audit(ctx, tx, actor(ctx), "registration.removed", "player", in.PlayerID, "", nil); err != nil {
			return err
		}
		if pair != nil {
			out = note(row.Player.Name + " is off the list, and the pair " + pair.name + " is split.")
		} else {
			out = note(row.Player.Name + " is off the list.")
		}
		return core.Bump(ctx, tx, t.ID)
	})
	if err != nil {
		return noteOut{}, err
	}
	return out, nil
}

// mergePlayers is "Same person": the earlier row stays, the later one goes,
// and anything the earlier row lacked — a partner wish, a phone number — comes
// across. Anyone who had named the later row now points at the one that stays.
func mergePlayers(ctx context.Context, d *core.Deps, in mergeIn) (noteOut, error) {
	var out noteOut
	err := d.Tx(ctx, func(tx *sql.Tx) error {
		t, err := lockTournament(ctx, tx, d, in.TournamentID)
		if err != nil {
			return err
		}
		roster, err := store.Roster(ctx, tx, t.ID)
		if err != nil {
			return err
		}
		var keep, drop *store.TournamentPlayer
		for i := range roster {
			switch roster[i].Player.ID {
			case in.KeepID:
				keep = &roster[i]
			case in.DropID:
				drop = &roster[i]
			}
		}
		if keep == nil || drop == nil || in.KeepID == in.DropID {
			out = refuse("One of them is not on the list any more.")
			return nil
		}
		pair, err := pairOf(ctx, tx, t.ID, in.DropID)
		if err != nil {
			return err
		}
		if late := tooLate(drop.Player.Name, pair); late != "" {
			out = refuse(late)
			return nil
		}
		if pair != nil {
			if _, err := tx.ExecContext(ctx, `delete from teams where id = $1`, pair.teamID); err != nil {
				return err
			}
		}
		if (keep.PartnerWish == nil || *keep.PartnerWish == "") && drop.PartnerWish != nil {
			var partner any
			if drop.PartnerPlayerID != nil && *drop.PartnerPlayerID != in.KeepID {
				partner = *drop.PartnerPlayerID
			}
			if _, err := tx.ExecContext(ctx,
				`update tournament_players set partner_wish = $2, partner_player_id = $3 where id = $1`,
				keep.ID, *drop.PartnerWish, partner); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `
			update tournament_players set partner_player_id = $3
			where tournament_id = $1 and partner_player_id = $2 and player_id <> $3`,
			t.ID, in.DropID, in.KeepID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `delete from tournament_players where id = $1`, drop.ID); err != nil {
			return err
		}
		if (keep.Player.PhoneKey == nil) && drop.Player.PhoneKey != nil {
			if _, err := tx.ExecContext(ctx,
				`update players set phone = null, phone_key = null where id = $1`, in.DropID); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx,
				`update players set phone = $2, phone_key = $3 where id = $1`,
				in.KeepID, drop.Player.Phone, *drop.Player.PhoneKey); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `
			update pending_registrations set status = 'merged', reviewed_at = now()
			where tournament_id = $1 and (player_id = $2 or matched_player_id = $2)`,
			t.ID, in.DropID); err != nil {
			return err
		}
		// A player row that was only ever this one mistaken sign-up goes
		// with it.
		var elsewhere int
		if err := tx.QueryRowContext(ctx,
			`select count(*)::int from tournament_players where player_id = $1`, in.DropID).Scan(&elsewhere); err != nil {
			return err
		}
		if elsewhere == 0 {
			if _, err := tx.ExecContext(ctx, `delete from players where id = $1`, in.DropID); err != nil {
				return err
			}
		}
		if err := settleOrphanFlags(ctx, tx, t.ID); err != nil {
			return err
		}
		if err := core.Audit(ctx, tx, actor(ctx), "registration.merged", "player", in.KeepID, "",
			map[string]any{"droppedPlayerId": in.DropID}); err != nil {
			return err
		}
		out = note(drop.Player.Name + " and " + keep.Player.Name + " are one person on the list now.")
		return core.Bump(ctx, tx, t.ID)
	})
	if err != nil {
		return noteOut{}, err
	}
	return out, nil
}

// keepBoth is "Different": the flag comes off and both stay. Two Karthiks in
// one group is not unusual and the organiser knows which is which.
func keepBoth(ctx context.Context, d *core.Deps, in playerIn) (okOut, error) {
	err := d.Tx(ctx, func(tx *sql.Tx) error {
		t, err := lockTournament(ctx, tx, d, in.TournamentID)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			update pending_registrations set status = 'kept', reviewed_at = now()
			where tournament_id = $1 and player_id = $2 and status = 'pending'`, t.ID, in.PlayerID); err != nil {
			return err
		}
		if err := core.Audit(ctx, tx, actor(ctx), "registration.kept_both", "player", in.PlayerID, "", nil); err != nil {
			return err
		}
		return core.Bump(ctx, tx, t.ID)
	})
	if err != nil {
		return okOut{}, err
	}
	return okOut{OK: true}, nil
}

// ── the two public ones ───────────────────────────────────────────────────

// resolveToken turns a raw link into its tournament, or nothing at all. Every
// reason to say no — unknown, revoked, the day has passed, the tournament was
// deleted — is one answer, so the link cannot be used to learn anything.
func resolveToken(ctx context.Context, d *core.Deps, raw string) (*store.Tournament, error) {
	normalized := normalizeCrockford(raw)
	prefix := normalized
	if len(prefix) > 5 {
		prefix = prefix[:5]
	}
	gate, err := core.CheckAllowed(ctx, d.DB, d.Now(), kindSignup, prefix)
	if err != nil {
		return nil, err
	}
	if !gate.Allowed {
		return nil, nil
	}
	var tournamentID string
	err = d.DB.QueryRowContext(ctx,
		`select tournament_id from registration_tokens where token_hash = $1 and revoked_at is null limit 1`,
		core.Sha256Hex(normalized)).Scan(&tournamentID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if errors.Is(err, sql.ErrNoRows) {
		return nil, core.RecordAttempt(ctx, d.DB, kindSignup, prefix, false)
	}
	t, err := store.TournamentByID(ctx, d.DB, d.Venue.ID, tournamentID)
	if store.IsNotFound(err) {
		return nil, core.RecordAttempt(ctx, d.DB, kindSignup, prefix, false)
	}
	if err != nil {
		return nil, err
	}
	if dayHasPassed(d, t) {
		return nil, core.RecordAttempt(ctx, d.DB, kindSignup, prefix, false)
	}
	if err := core.RecordAttempt(ctx, d.DB, kindSignup, prefix, true); err != nil {
		return nil, err
	}
	return t, nil
}

func resolveRegistrationToken(ctx context.Context, d *core.Deps, in resolveTokenIn) (resolveTokenOut, error) {
	t, err := resolveToken(ctx, d, in.Token)
	if err != nil {
		return resolveTokenOut{}, err
	}
	if t == nil {
		return resolveTokenOut{}, rpc.NotFound("This link doesn’t work any more.")
	}
	var out resolveTokenOut
	out.Tournament.Name = t.Name
	out.Tournament.Day = t.Day
	out.Discipline = t.Discipline
	out.Closed = signupsClosed(t)
	return out, nil
}

// safeDeviceID — a per-browser id the form generates and keeps in
// localStorage. Deliberately not a cookie, so the page stays cookie-free.
func safeDeviceID(raw *string) string {
	if raw == nil {
		return ""
	}
	s := *raw
	if len(s) < 8 || len(s) > 64 {
		return ""
	}
	for _, r := range s {
		if !(r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return ""
		}
	}
	return s
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// submitRegistration is the public form. Straight onto the list — unless they
// are on it already, which is the common case: people reload, or come back to
// add a partner. "Already" is the same phone number under the same name; the
// same name with no number goes on with a flag, because two Karthiks in one
// group is not unusual and the organiser knows which is which.
func submitRegistration(ctx context.Context, d *core.Deps, in submitIn) (submitOut, error) {
	device := safeDeviceID(in.DeviceID)
	// The guard is per browser as well as per link: the link is public, so
	// the only other thing a script and a person do differently is how often
	// they get it wrong. A refusal counts; a sign-up clears the count.
	deviceKey := ""
	if device != "" {
		deviceKey = "dev:" + device
		gate, err := core.CheckAllowed(ctx, d.DB, d.Now(), kindSignup, deviceKey)
		if err != nil {
			return submitOut{}, err
		}
		if !gate.Allowed {
			// Already waiting: saying so again would only extend the wait.
			return submitOut{Error: "This link doesn’t work any more. Ask the organiser."}, nil
		}
	}
	no := func(msg string) (submitOut, error) {
		if deviceKey != "" {
			if err := core.RecordAttempt(ctx, d.DB, kindSignup, deviceKey, false); err != nil {
				return submitOut{}, err
			}
		}
		return submitOut{Error: msg}, nil
	}
	t, err := resolveToken(ctx, d, in.Token)
	if err != nil {
		return submitOut{}, err
	}
	if t == nil {
		return no("This link doesn’t work any more. Ask the organiser.")
	}
	if signupsClosed(t) {
		return no("Sign-ups have closed — ask the organiser.")
	}

	// Cut before validating, so a 5,000-character paste is a name that is too
	// long rather than a row the database refuses.
	name := strings.TrimSpace(cutRunes(in.Name, 200))
	phone := strings.TrimSpace(cutRunes(str(in.Phone), 40))
	partner := strings.TrimSpace(cutRunes(str(in.PartnerName), 200))
	if t.Discipline == "singles" {
		partner = ""
	}
	if len([]rune(name)) < 2 {
		return no("Put your name in.")
	}
	if len([]rune(name)) > 60 {
		return no("That name is too long.")
	}
	nameKey := engine.NormalizeName(name)
	phoneKey := engine.NormalizePhone(phone)
	if phone != "" && phoneKey == "" {
		return no("That phone number doesn’t look right — ten digits, or leave it blank.")
	}

	var out submitOut
	err = d.Tx(ctx, func(tx *sql.Tx) error {
		locked, err := lockTournament(ctx, tx, d, t.ID)
		if err != nil {
			return err
		}
		if signupsClosed(locked) {
			// Closed between the read and the lock: two taps, one moment.
			out = submitOut{Error: "Sign-ups have closed — ask the organiser."}
			return nil
		}
		roster, err := store.Roster(ctx, tx, locked.ID)
		if err != nil {
			return err
		}
		// The same number under the same name is the same person, back for
		// another Sunday. A number alone must not answer "is so-and-so
		// playing", nor let a stranger with the number change a partner wish.
		var mine *store.TournamentPlayer
		if phoneKey != "" {
			for i := range roster {
				p := roster[i].Player
				if p.PhoneKey != nil && *p.PhoneKey == phoneKey && p.NameKey == nameKey {
					mine = &roster[i]
					break
				}
			}
		}
		if mine != nil {
			// Coming back to say who they are playing with is the one edit
			// worth taking.
			if partner != "" && (mine.PartnerWish == nil || *mine.PartnerWish == "") {
				partnerKey := engine.NormalizeName(partner)
				var partnerID any
				if partnerKey != mine.Player.NameKey {
					for _, r := range roster {
						if r.Player.NameKey == partnerKey {
							partnerID = r.Player.ID
							break
						}
					}
				}
				if _, err := tx.ExecContext(ctx,
					`update tournament_players set partner_wish = $2, partner_player_id = $3 where id = $1`,
					mine.ID, cleanText(partner, 60), partnerID); err != nil {
					return err
				}
				if err := core.Bump(ctx, tx, locked.ID); err != nil {
					return err
				}
			}
			out = submitOut{OK: true, AlreadyIn: true}
			return nil
		}
		res, err := addPlayer(ctx, tx, d, locked, addInput{
			name: name, phone: phone, partnerWish: partner, source: "link"})
		if err != nil {
			return err
		}
		if res.refusal != "" {
			out = submitOut{Error: res.refusal}
			return nil
		}
		out = submitOut{OK: true}
		return nil
	})
	if err != nil {
		return submitOut{}, err
	}
	if deviceKey != "" {
		// A sign-up that took clears this browser's count; one that was
		// refused adds to it.
		if err := core.RecordAttempt(ctx, d.DB, kindSignup, deviceKey, out.OK); err != nil {
			return submitOut{}, err
		}
	}
	return out, nil
}
