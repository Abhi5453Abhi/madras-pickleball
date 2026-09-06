// Package db opens the database and brings its schema up.
package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"sort"
	"strings"
	"time"

	_ "github.com/lib/pq"

	"mpb/migrations"
)

// Open connects with a pool sized for one small container. Neon's pooled
// host allows few connections per client; five is plenty for twenty people.
func Open(url string) (*sql.DB, error) {
	d, err := sql.Open("postgres", url)
	if err != nil {
		return nil, err
	}
	d.SetMaxOpenConns(5)
	d.SetMaxIdleConns(2)
	d.SetConnMaxIdleTime(5 * time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := d.PingContext(ctx); err != nil {
		d.Close()
		return nil, fmt.Errorf("db: cannot reach the database: %w", err)
	}
	return d, nil
}

// Migrate applies every migrations/*.sql the database has not seen, in
// name order, each in its own transaction, under an advisory lock so two
// containers starting together take turns. A statement that fails rolls its
// whole file back, so a crash halfway leaves nothing half-made.
func Migrate(ctx context.Context, d *sql.DB, log *slog.Logger) error {
	conn, err := d.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()

	// Session-level lock on this one connection; released when it closes.
	if _, err := conn.ExecContext(ctx, `select pg_advisory_lock(7231001)`); err != nil {
		return fmt.Errorf("db: advisory lock: %w", err)
	}
	defer conn.ExecContext(context.Background(), `select pg_advisory_unlock(7231001)`) //nolint:errcheck

	if _, err := conn.ExecContext(ctx, `create table if not exists schema_migrations (
		name text primary key, applied_at timestamptz not null default now())`); err != nil {
		return err
	}
	applied := map[string]bool{}
	rows, err := conn.QueryContext(ctx, `select name from schema_migrations`)
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
	for _, name := range names {
		if applied[name] {
			continue
		}
		body, err := fs.ReadFile(migrations.FS, name)
		if err != nil {
			return err
		}
		tx, err := conn.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, string(body)); err != nil {
			tx.Rollback()
			return fmt.Errorf("db: migration %s: %w", name, err)
		}
		if _, err := tx.ExecContext(ctx, `insert into schema_migrations (name) values ($1)`, name); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
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
