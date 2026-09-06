// Package assets holds the built React app. `dist` is filled by `npm run
// build` in web/ (or the Dockerfile); in a bare checkout it holds only
// .gitkeep and the server answers every page with "the web app is not built".
package assets

import "embed"

//go:embed all:dist
var Dist embed.FS
