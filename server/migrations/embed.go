// Package migrations carries the schema so the binary can bring an empty
// database up on its own: a container has nobody to run a setup command.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
