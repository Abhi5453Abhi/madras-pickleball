package db

import "testing"

func TestCleanURL(t *testing.T) {
	cases := map[string]string{
		"postgres://u:p@ep-x.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require": "postgres://u:p@ep-x.ap-southeast-1.aws.neon.tech/neondb?sslmode=require",
		"postgresql://u:p@ep-x.neon.tech/neondb":                                                          "postgresql://u:p@ep-x.neon.tech/neondb?sslmode=require",
		"postgres://postgres@localhost:5433/mpb?sslmode=disable":                                          "postgres://postgres@localhost:5433/mpb?sslmode=disable",
		"postgres://postgres@localhost:5433/mpb":                                                          "postgres://postgres@localhost:5433/mpb",
	}
	for in, want := range cases {
		if got := cleanURL(in); got != want {
			t.Errorf("cleanURL(%q)\n got %q\nwant %q", in, got, want)
		}
	}
}
