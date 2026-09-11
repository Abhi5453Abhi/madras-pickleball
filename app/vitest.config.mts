import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const src = fileURLToPath(new URL('./src', import.meta.url))

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    /**
     * The database-backed tests boot a WASM Postgres (PGlite) per file. That is
     * a second or two on a cold run and nothing afterwards, but the default 5s
     * hook timeout is not enough for it.
     */
    hookTimeout: 60_000,
    testTimeout: 20_000,
  },
  resolve: {
    /**
     * Regexes, not bare strings: a `'@'` alias would also swallow
     * `@electric-sql/pglite`, which is exactly the package the database tests
     * need to resolve for real.
     */
    alias: [
      { find: /^@\//, replacement: `${src}/` },
      // `server-only` throws when it is imported outside a React Server
      // Component graph. It is a bundler guard, not a runtime one, and the
      // modules under test are server modules by construction.
      { find: /^server-only$/, replacement: `${src}/test/server-only.ts` },
      // `headers()` needs a request. Nothing under test calls it; the import
      // only has to resolve.
      { find: /^next\/headers$/, replacement: `${src}/test/next-headers.ts` },
    ],
  },
})
