# Day-to-day commands. `make dev` runs the Go server and Vite together.
DB ?= postgres://postgres@localhost:5433/mpb_go?sslmode=disable

.PHONY: dev server web build test check

server:            ## the Go server on :8080
	cd server && DATABASE_URL="$(DB)" go run ./cmd/mpb

web:               ## Vite on :5173, proxying /api to :8080
	cd web && npm run dev

build:             ## the web app, then the binary that embeds it
	cd web && npm run build
	cd server && go build -o ../bin/mpb ./cmd/mpb

test:              ## Go tests (database tests need MPB_TEST_DATABASE_URL)
	cd server && go vet ./... && go test -p 1 ./...

check: test        ## everything the CI would run
	cd web && npx tsc -b && npx vite build
