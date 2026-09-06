package setup

import (
	"strings"
	"testing"
)

func TestTeamBoardSettlesMutualPairs(t *testing.T) {
	h := newHarness(t)
	tourney := h.create(createEventIn{Name: "Men's Doubles"})
	h.mustAdd(tourney.ID, "Ravi Kumar", "Priya Sharma", "Suresh Babu", "Ganesh Iyer", "Arun Prakash", "Deepa Nair")

	// Ravi and Priya named each other; Suresh named Ganesh and Ganesh nobody;
	// Arun named somebody who never signed up.
	h.wish(tourney.ID, "Ravi Kumar", "Priya Sharma")
	h.wish(tourney.ID, "Priya Sharma", "Ravi Kumar")
	h.wish(tourney.ID, "Suresh Babu", "Ganesh Iyer")
	if _, err := h.DB.ExecContext(h.ctx,
		`update tournament_players set partner_wish = 'Someone Else' where tournament_id = $1 and player_id = $2`,
		tourney.ID, h.playerID(tourney.ID, "Arun Prakash")); err != nil {
		t.Fatalf("wish: %v", err)
	}

	board, err := teamBoard(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if err != nil {
		t.Fatalf("teamBoard: %v", err)
	}
	if board.Discipline != "doubles" || board.Needed != 3 || board.Locked {
		t.Fatalf("board: %+v", board)
	}
	if len(board.Pairs) != 1 {
		t.Fatalf("the mutual pair settles on load: %+v", board.Pairs)
	}
	pair := board.Pairs[0]
	if pair.How != "mutual" || pair.Name != "Ravi Kumar / Priya Sharma" {
		t.Fatalf("the pair: %+v", pair)
	}
	if len(pair.Players) != 2 || pair.Players[0].Name != "Ravi Kumar" {
		t.Fatalf("members in order: %+v", pair.Players)
	}
	if len(board.Unpaired) != 4 {
		t.Fatalf("four are left: %+v", board.Unpaired)
	}
	// Sign-up order, not alphabetical.
	if board.Unpaired[0].Name != "Suresh Babu" || board.Unpaired[3].Name != "Deepa Nair" {
		t.Fatalf("unpaired in sign-up order: %+v", board.Unpaired)
	}
	byName := map[string]boardUnpaired{}
	for _, u := range board.Unpaired {
		byName[u.Name] = u
	}
	if got := byName["Suresh Babu"]; got.Note == nil || *got.Note != "Ganesh named nobody" {
		t.Fatalf("Suresh's note: %+v", got.Note)
	}
	if got := byName["Suresh Babu"]; got.WishPlayerName == nil || *got.WishPlayerName != "Ganesh Iyer" {
		t.Fatalf("Suresh's wish: %+v", got)
	}
	// A wish that never signed up says nothing, and the row offers "Pair with…".
	if got := byName["Arun Prakash"]; got.Note != nil || got.WishPlayerName != nil {
		t.Fatalf("Arun named nobody who is here: %+v", got)
	}
	if got := byName["Arun Prakash"]; got.WishText == nil || *got.WishText != "Someone Else" {
		t.Fatalf("Arun's wish text as typed: %+v", got)
	}

	// Settling is idempotent: a second load makes no more pairs.
	again, _ := teamBoard(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if len(again.Pairs) != 1 {
		t.Fatalf("settling twice: %+v", again.Pairs)
	}
}

func TestPairByHandSplitAndRandom(t *testing.T) {
	h := newHarness(t)
	tourney := h.create(createEventIn{Name: "Men's Doubles"})
	h.mustAdd(tourney.ID, "Ravi Kumar", "Priya Sharma", "Suresh Babu", "Ganesh Iyer", "Arun Prakash")

	ravi := h.playerID(tourney.ID, "Ravi Kumar")
	priya := h.playerID(tourney.ID, "Priya Sharma")
	suresh := h.playerID(tourney.ID, "Suresh Babu")

	if res, _ := pairWith(h.ctx, h.Deps, pairWithIn{TournamentID: tourney.ID, PlayerA: ravi, PlayerB: ravi}); res.OK ||
		res.Error != "Pick two different people." {
		t.Fatalf("pairing somebody with themself: %+v", res)
	}
	if res, _ := pairWith(h.ctx, h.Deps, pairWithIn{TournamentID: tourney.ID, PlayerA: ravi, PlayerB: "ply_nobody"}); res.OK ||
		res.Error != "One of them is no longer on the list." {
		t.Fatalf("pairing with a stranger: %+v", res)
	}

	made, err := pairWith(h.ctx, h.Deps, pairWithIn{TournamentID: tourney.ID, PlayerA: ravi, PlayerB: priya})
	if err != nil || !made.OK {
		t.Fatalf("pairWith: %+v %v", made, err)
	}
	if res, _ := pairWith(h.ctx, h.Deps, pairWithIn{TournamentID: tourney.ID, PlayerA: ravi, PlayerB: suresh}); res.OK ||
		res.Error != "Ravi Kumar is in a pair already. Split it first." {
		t.Fatalf("pairing somebody twice: %+v", res)
	}

	board, _ := teamBoard(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if len(board.Pairs) != 1 || board.Pairs[0].How != "organiser" {
		t.Fatalf("a pair the organiser made: %+v", board.Pairs)
	}

	// Split it, and both go back to the pile.
	if res, _ := splitTeam(h.ctx, h.Deps, splitTeamIn{TournamentID: tourney.ID, TeamID: made.TeamID}); !res.OK {
		t.Fatalf("splitTeam: %+v", res)
	}
	if res, _ := splitTeam(h.ctx, h.Deps, splitTeamIn{TournamentID: tourney.ID, TeamID: made.TeamID}); res.OK ||
		res.Error != "That pair is already gone." {
		t.Fatalf("splitting twice: %+v", res)
	}
	board, _ = teamBoard(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if len(board.Pairs) != 0 || len(board.Unpaired) != 5 {
		t.Fatalf("after the split: %d pairs, %d unpaired", len(board.Pairs), len(board.Unpaired))
	}

	// Five is odd: two pairs and somebody named as left over.
	rest, err := pairRestRandomly(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if err != nil {
		t.Fatalf("pairRestRandomly: %v", err)
	}
	if !rest.OK || rest.Made != 2 || rest.OddOut == nil {
		t.Fatalf("five people: two pairs and one left over, got %+v", rest)
	}
	board, _ = teamBoard(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if len(board.Pairs) != 2 || len(board.Unpaired) != 1 {
		t.Fatalf("after the random pairing: %+v", board)
	}
	if board.Unpaired[0].ID != rest.OddOut.ID {
		t.Fatalf("the one left over is named: %+v vs %+v", board.Unpaired[0], rest.OddOut)
	}

	// Only one left: there is nobody to pair them with.
	res, _ := pairRestRandomly(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if res.OK || !strings.HasSuffix(res.Error, " is left — there is nobody to pair them with.") {
		t.Fatalf("one left: %+v", res)
	}

	// Take them off, and everyone is paired.
	if r, _ := removePlayer(h.ctx, h.Deps, playerIn{TournamentID: tourney.ID,
		PlayerID: board.Unpaired[0].ID}); !r.OK {
		t.Fatalf("removePlayer: %+v", r)
	}
	res, _ = pairRestRandomly(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if res.OK || res.Error != "Everyone is paired." {
		t.Fatalf("nobody left: %+v", res)
	}
}

func TestChangingAPairDropsAStaleDraw(t *testing.T) {
	h := newHarness(t)
	id := withPairs(t, h, 2, "final_only")
	if r, _ := generateDraw(h.ctx, h.Deps, tournamentIDIn{TournamentID: id}); !r.OK {
		t.Fatalf("generateDraw: %+v", r)
	}
	if len(h.matches(id)) == 0 {
		t.Fatal("the draw was made")
	}
	teams := h.teams(id)
	if res, _ := splitTeam(h.ctx, h.Deps, splitTeamIn{TournamentID: id, TeamID: teams[0].ID}); !res.OK {
		t.Fatalf("splitTeam: %+v", res)
	}
	// The schedule pointed at that pair; it goes with it.
	if got := len(h.matches(id)); got != 0 {
		t.Fatalf("a stale draw survived: %d matches", got)
	}
	after := h.reload(id)
	if after.DrawMadeAt != nil || after.AdvancePerGroup != 0 {
		t.Fatalf("the draw's marks are cleared too: %+v", after)
	}
	var groups int
	if err := h.DB.QueryRowContext(h.ctx, `select count(*)::int from groups where tournament_id = $1`, id).
		Scan(&groups); err != nil {
		t.Fatalf("groups: %v", err)
	}
	if groups != 0 {
		t.Fatalf("the pools went too, got %d", groups)
	}
	for _, tm := range h.teams(id) {
		if tm.GroupID != nil {
			t.Fatalf("%s still points at a pool", tm.Name)
		}
	}
}

func TestPairsAreLockedOnceItHasStarted(t *testing.T) {
	h := newHarness(t)
	id := withPairs(t, h, 2, "final_only")
	if r, _ := generateDraw(h.ctx, h.Deps, tournamentIDIn{TournamentID: id}); !r.OK {
		t.Fatalf("generateDraw: %+v", r)
	}
	if r, _ := startEvent(h.ctx, h.Deps, tournamentIDIn{TournamentID: id}); !r.OK {
		t.Fatalf("startEvent: %+v", r)
	}

	board, err := teamBoard(h.ctx, h.Deps, tournamentIDIn{TournamentID: id})
	if err != nil {
		t.Fatalf("teamBoard: %v", err)
	}
	if !board.Locked {
		t.Fatal("the board is locked once it has started")
	}
	teams := h.teams(id)
	if res, _ := splitTeam(h.ctx, h.Deps, splitTeamIn{TournamentID: id, TeamID: teams[0].ID}); res.OK ||
		res.Error != lockedMessage {
		t.Fatalf("splitting after the start: %+v", res)
	}
	if res, _ := pairWith(h.ctx, h.Deps, pairWithIn{TournamentID: id,
		PlayerA: h.roster(id)[0].Player.ID, PlayerB: h.roster(id)[1].Player.ID}); res.OK || res.Error != lockedMessage {
		t.Fatalf("pairing after the start: %+v", res)
	}
	if res, _ := pairRestRandomly(h.ctx, h.Deps, tournamentIDIn{TournamentID: id}); res.OK ||
		res.Error != lockedMessage {
		t.Fatalf("random pairing after the start: %+v", res)
	}
	if lockedMessage != "The tournament has started. Changing a pair is under More." {
		t.Fatalf("the locked message is on screen, verbatim: %q", lockedMessage)
	}
}

func TestSinglesHasNoPairsToMake(t *testing.T) {
	h := newHarness(t)
	tourney := h.create(createEventIn{Name: "Women's Singles", Gender: "womens", Discipline: "singles"})
	h.mustAdd(tourney.ID, "Anitha R", "Divya K")

	board, err := teamBoard(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if err != nil {
		t.Fatalf("teamBoard: %v", err)
	}
	// Every singles player is a team of one, so nobody is in the pile.
	if len(board.Pairs) != 2 || len(board.Unpaired) != 0 || board.Needed != 2 {
		t.Fatalf("singles board: %+v", board)
	}
	if res, _ := pairRestRandomly(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID}); res.OK ||
		res.Error != "Singles has no pairs to make." {
		t.Fatalf("pairing in singles: %+v", res)
	}
}

func TestAPairBrokenBySomebodyLeavingComesApart(t *testing.T) {
	h := newHarness(t)
	tourney := h.create(createEventIn{Name: "Men's Doubles"})
	h.mustAdd(tourney.ID, "Ravi Kumar", "Priya Sharma", "Arun Prakash", "Deepa Nair")
	if res, _ := pairRestRandomly(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID}); !res.OK {
		t.Fatalf("pairRestRandomly: %+v", res)
	}
	board, _ := teamBoard(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if len(board.Pairs) != 2 {
		t.Fatalf("two pairs: %+v", board.Pairs)
	}
	// Take one person off; removePlayer splits their pair, and the other one
	// is back in the pile on the next load.
	gone := board.Pairs[0].Players[0]
	if res, _ := removePlayer(h.ctx, h.Deps, playerIn{TournamentID: tourney.ID, PlayerID: gone.ID}); !res.OK {
		t.Fatalf("removePlayer: %+v", res)
	}
	board, _ = teamBoard(h.ctx, h.Deps, tournamentIDIn{TournamentID: tourney.ID})
	if len(board.Pairs) != 1 || len(board.Unpaired) != 1 {
		t.Fatalf("one pair and one in the pile: %+v", board)
	}
}
