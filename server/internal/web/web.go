// Package web serves the built React app from the binary.
package web

import (
	"io/fs"
	"net/http"
	"path"
	"strings"

	"mpb/assets"
)

// Handler serves files under assets/dist. Hashed assets (/assets/…) are
// immutable; everything else is a page and gets index.html, which the
// router in the browser turns into the right screen. index.html itself is
// never cached, so a new deployment shows up on the next load.
func Handler() http.Handler {
	dist, err := fs.Sub(assets.Dist, "dist")
	if err != nil {
		panic(err)
	}
	files := http.FileServerFS(dist)
	index, indexErr := fs.ReadFile(dist, "index.html")

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := path.Clean("/" + r.URL.Path)
		if p != "/" {
			if f, err := dist.Open(strings.TrimPrefix(p, "/")); err == nil {
				st, stErr := f.Stat()
				f.Close()
				if stErr == nil && !st.IsDir() {
					if strings.HasPrefix(p, "/assets/") {
						w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
					} else {
						w.Header().Set("Cache-Control", "public, max-age=3600")
					}
					files.ServeHTTP(w, r)
					return
				}
			}
		}
		if indexErr != nil {
			http.Error(w, "The web app is not built. Run `npm run build` in web/ first.", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		// The organiser's pages and the sign-up form must never be indexed;
		// the public results page is fine.
		if strings.HasPrefix(p, "/admin") || strings.HasPrefix(p, "/r/") || p == "/login" {
			w.Header().Set("X-Robots-Tag", "noindex")
		}
		w.Write(index) //nolint:errcheck
	})
}
