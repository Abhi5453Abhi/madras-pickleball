// Package db opens the database and brings its schema up.
package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	neturl "net/url"
	"sort"
	"strings"
	"time"

	_ "github.com/lib/pq"

	"mpb/migrations"
)

// Open connects with a pool sized for one small container. Neon's pooled
// host allows few connections per client; five is plenty for twenty people.
func Open(url string) (*sql.DB, error) {
	d, err := sql.Open("postgres", cleanURL(url))
	if err != nil {
		return nil, err
	}
	d.SetMaxOpenConns(5)
	d.SetMaxIdleConns(2)
	d.SetConnMaxIdleTime(5 * time.Minute)
	// Neon's pooler and its autosuspend both like connections that are not
	// kept for ever.
	d.SetConnMaxLifetime(30 * time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := d.PingContext(ctx); err != nil {
		d.Close()
		return nil, fmt.Errorf("db: cannot reach the database: %w", err)
	}
	return d, nil
}

// cleanURL makes a hosted database's connection string usable by lib/pq:
// Neon's strings carry `channel_binding=require`, which the driver would
// pass to the server as a setting it does not have, and a remote host with
// no sslmode named gets `require` — nothing here should ever travel in the
// clear.
func cleanURL(raw string) string {
	u, err := neturl.Parse(raw)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		return raw
	}
	q := u.Query()
	q.Del("channel_binding")
	host := u.Hostname()
	// `require` encrypts but takes any certificate; a hosted database has a
	// public CA behind it, so ask for the name on it to be checked too.
	if mode := q.Get("sslmode"); (mode == "" || mode == "require") && host != "localhost" && host != "127.0.0.1" && host != "" {
		q.Set("sslmode", "verify-full")
	}
	u.RawQuery = q.Encode()
	return u.String()
}

// Migrate applies every migrations/*.sql the database has not seen, in
// name order, all inside ONE transaction that holds an advisory lock — so
// two containers starting together take turns, a crash halfway leaves
// nothing half-made, and it works through a connection pooler like Neon's,
// which only keeps a transaction on one backend (a session-level lock would
// be taken on one connection and the DDL run on another).
func Migrate(ctx context.Context, d *sql.DB, log *slog.Logger) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck

	if _, err := tx.ExecContext(ctx, `select pg_advisory_xact_lock(7231001)`); err != nil {
		return fmt.Errorf("db: advisory lock: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `create table if not exists schema_migrations (
		name text primary key, applied_at timestamptz not null default now())`); err != nil {
		return err
	}
	applied := map[string]bool{}
	rows, err := tx.QueryContext(ctx, `select name from schema_migrations`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			rows.Close()
			return err
		}
		applied[n] = true
	}
	rows.Close()

	names, err := fs.Glob(migrations.FS, "*.sql")
	if err != nil {
		return err
	}
	sort.Strings(names)
	var done []string
	for _, name := range names {
		if applied[name] {
			continue
		}
		body, err := fs.ReadFile(migrations.FS, name)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, string(body)); err != nil {
			return fmt.Errorf("db: migration %s: %w", name, err)
		}
		if _, err := tx.ExecContext(ctx, `insert into schema_migrations (name) values ($1)`, name); err != nil {
			return err
		}
		done = append(done, name)
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	for _, name := range done {
		log.Info("migration applied", "name", name)
	}
	return nil
}

// Tx runs fn inside a transaction, committing when it returns nil.
func Tx(ctx context.Context, d *sql.DB, fn func(tx *sql.Tx) error) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

// IsUniqueViolation reports whether err is Postgres refusing a duplicate —
// the signal a race lost, which callers turn into a calm message.
func IsUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	// lib/pq wraps the SQLSTATE in its Error type; matching the text keeps
	// this package free of the driver's types.
	return strings.Contains(err.Error(), "duplicate key value") || strings.Contains(err.Error(), "SQLSTATE 23505")
}

// ErrNotFound is what a lookup returns for a row that is not there.
var ErrNotFound = errors.New("not found")

// NoRows turns sql.ErrNoRows into ErrNotFound and leaves everything else.
func NoRows(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}
