package setup

import (
	"strings"
	"testing"
)

func TestCourtsAddRenameRemove(t *testing.T) {
	h := newHarness(t)

	courts, err := venueCourts(h.ctx, h.Deps)
	if err != nil {
		t.Fatalf("venueCourts: %v", err)
	}
	if len(courts) != 4 {
		t.Fatalf("a fresh venue has four courts, got %d", len(courts))
	}
	if courts[0].Name != "Court 1" || len(courts[0].HeldBy) != 0 {
		t.Fatalf("first court is %+v", courts[0])
	}

	// Add one.
	if res, _ := addCourt(h.ctx, h.Deps, addCourtIn{Name: "Court 5"}); res.Note != "Court 5 is in." {
		t.Fatalf("addCourt: %+v", res)
	}
	// The same name in any case is refused, naming what is already there.
	res, _ := addCourt(h.ctx, h.Deps, addCourtIn{Name: "court 5"})
	if res.OK || res.Error != "There is already a Court 5." {
		t.Fatalf("duplicate court: %+v", res)
	}
	// An empty name says what to type.
	res, _ = addCourt(h.ctx, h.Deps, addCourtIn{Name: "   "})
	if res.OK || !strings.HasPrefix(res.Error, "Give the court a name") {
		t.Fatalf("empty court name: %+v", res)
	}

	courts, _ = venueCourts(h.ctx, h.Deps)
	if len(courts) != 5 {
		t.Fatalf("five courts now, got %d", len(courts))
	}
	fifth := courts[4]
	if fifth.ColorKey != "clay" {
		t.Fatalf("the fifth court takes the fifth swatch, got %q", fifth.ColorKey)
	}

	// Rename it.
	if res, _ := renameCourt(h.ctx, h.Deps, renameCourtIn{CourtID: fifth.ID, Name: "Centre Court"}); res.Note != "Renamed." {
		t.Fatalf("renameCourt: %+v", res)
	}
	res, _ = renameCourt(h.ctx, h.Deps, renameCourtIn{CourtID: fifth.ID, Name: "Court 1"})
	if res.OK || res.Error != "There is already a Court 1." {
		t.Fatalf("rename clash: %+v", res)
	}
	res, _ = renameCourt(h.ctx, h.Deps, renameCourtIn{CourtID: fifth.ID, Name: ""})
	if res.OK || res.Error != "A court needs a name." {
		t.Fatalf("rename to nothing: %+v", res)
	}

	// A tournament takes it, and then it cannot be taken out.
	tourney := h.create(createEventIn{Name: "Men's Doubles — September", Courts: []string{fifth.ID}})
	courts, _ = venueCourts(h.ctx, h.Deps)
	var held []string
	for _, c := range courts {
		if c.ID == fifth.ID {
			held = c.HeldBy
		}
	}
	if len(held) != 1 || held[0] != "Men's Doubles — September" {
		t.Fatalf("Centre Court should say who uses it, got %v", held)
	}
	res, _ = removeCourt(h.ctx, h.Deps, courtIDIn{CourtID: fifth.ID})
	if res.OK || res.Error != "Centre Court belongs to Men's Doubles — September. Take it off there first, under Schedule & courts." {
		t.Fatalf("removing a held court: %+v", res)
	}

	// A free one comes out, and comes back with its history.
	free := courts[3]
	if res, _ := removeCourt(h.ctx, h.Deps, courtIDIn{CourtID: free.ID}); !res.OK {
		t.Fatalf("removeCourt: %+v", res)
	}
	courts, _ = venueCourts(h.ctx, h.Deps)
	if len(courts) != 4 {
		t.Fatalf("four courts after taking one out, got %d", len(courts))
	}
	if res, _ := addCourt(h.ctx, h.Deps, addCourtIn{Name: free.Name}); res.Note != free.Name+" is in." {
		t.Fatalf("re-adding: %+v", res)
	}
	courts, _ = venueCourts(h.ctx, h.Deps)
	back := ""
	for _, c := range courts {
		if c.ID == free.ID {
			back = c.Name
		}
	}
	if back != free.Name {
		t.Fatalf("the same row came back, not a new one; got %q", back)
	}
	_ = tourney
}

func TestRemoveLastCourtRefused(t *testing.T) {
	h := newHarness(t)
	courts, _ := venueCourts(h.ctx, h.Deps)
	for i, c := range courts {
		res, err := removeCourt(h.ctx, h.Deps, courtIDIn{CourtID: c.ID})
		if err != nil {
			t.Fatalf("removeCourt: %v", err)
		}
		last := i == len(courts)-1
		if last {
			if res.OK || res.Error != "A venue needs at least one court." {
				t.Fatalf("the last court came out: %+v", res)
			}
			return
		}
		if !res.OK {
			t.Fatalf("court %s: %+v", c.Name, res)
		}
	}
}
