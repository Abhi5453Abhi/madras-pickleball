// mpb is the whole server: the API, the built web app, and the database
// setup, in one binary that runs the same on a laptop and in a container.
//
//	DATABASE_URL=postgres://… PORT=8080 mpb
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"mpb/internal/auth"
	"mpb/internal/core"
	"mpb/internal/db"
	"mpb/internal/modules"
	"mpb/internal/pin"
	"mpb/internal/rpc"
	"mpb/internal/web"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	// `mpb -hash 482913` prints the hash of a PIN and exits — for the runbook's
	// "an organiser has forgotten their PIN" fix, done by hand on the database.
	if len(os.Args) == 3 && os.Args[1] == "-hash" {
		p := pin.Normalize(os.Args[2])
		if p == "" {
			log.Error("a PIN is six digits")
			os.Exit(2)
		}
		h, err := pin.Hash(p)
		if err != nil {
			log.Error("hash", "err", err)
			os.Exit(1)
		}
		os.Stdout.WriteString(h + "\n")
		return
	}

	url := os.Getenv("DATABASE_URL")
	if url == "" {
		// What a database connected through a host's storage screen may be
		// called instead, depending on the prefix chosen there.
		url = os.Getenv("POSTGRES_URL")
	}
	if url == "" {
		log.Error("DATABASE_URL is not set — nothing to run against")
		os.Exit(2)
	}

	ctx := context.Background()
	conn, err := db.Open(url)
	if err != nil {
		log.Error("database", "err", err)
		os.Exit(1)
	}
	defer conn.Close()
	if err := db.Migrate(ctx, conn, log); err != nil {
		log.Error("migrate", "err", err)
		os.Exit(1)
	}
	venue, err := core.Seed(ctx, conn)
	if err != nil {
		log.Error("seed", "err", err)
		os.Exit(1)
	}

	deps := &core.Deps{DB: conn, Venue: venue, Log: log, Now: time.Now}
	reg := rpc.New(log)
	auth.Register(reg, deps)

	mux := http.NewServeMux()
	modules.Register(mux, reg, deps)
	mux.Handle("/api/rpc/{name}", reg.Handler())
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		if err := conn.PingContext(r.Context()); err != nil {
			rpc.WriteJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "database unreachable"})
			return
		}
		rpc.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		rpc.WriteJSON(w, http.StatusNotFound, map[string]string{"error": "No such endpoint."})
	})
	mux.Handle("/", web.Handler())

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	// Every request gets a deadline the database calls inherit, so one hung
	// query cannot pin a connection from a five-connection pool for a minute.
	deadline := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		mux.ServeHTTP(w, r.WithContext(ctx))
	})
	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           auth.Middleware(deps, deadline),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
		<-stop
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Shutdown(shutdown) //nolint:errcheck
	}()

	log.Info("serving", "port", port, "venue", venue.Name)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("server", "err", err)
		os.Exit(1)
	}
}
