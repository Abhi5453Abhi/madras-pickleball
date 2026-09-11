/**
 * Stands in for the `server-only` package under vitest.
 *
 * The real package throws unless it is resolved through the `react-server`
 * export condition, which a node test runner does not set. It is a guard that
 * stops a server module being pulled into a client bundle — a bundler concern,
 * not a runtime one — so under test it is simply absent.
 */
export {}
