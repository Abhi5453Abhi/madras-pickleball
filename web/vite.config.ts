import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'

const MOCK = process.env.MPB_MOCK === '1'

/**
 * The screens without a database — `MPB_MOCK=1 npx vite`.
 *
 * It answers /api/rpc/* and /api/version/* from the fixtures in `mock/`,
 * which are type-checked against docs/GO-API.ts, so a screen can be walked
 * and photographed before the Go side exists. Off by default: without
 * MPB_MOCK the plugin is not even added, and /api goes to the Go server.
 */
function mockApi(): Plugin {
  return {
    name: 'mpb-mock-api',
    async configureServer(server) {
      // Imported lazily so the fixtures (and the whole mock/ tree) are only
      // loaded when the mock is actually on.
      const { mockRpc, mockVersion } = await import('./mock/fixtures.ts')
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '/').split('?')[0]
        const send = (status: number, body: unknown) => {
          res.statusCode = status
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(body))
        }
        if (path.startsWith('/api/version/')) {
          const out = mockVersion(path.slice('/api/version/'.length))
          send(out.status, out.body)
          return
        }
        if (path.startsWith('/api/rpc/')) {
          const name = path.slice('/api/rpc/'.length)
          const chunks: Buffer[] = []
          req.on('data', (c: Buffer) => chunks.push(c))
          req.on('end', () => {
            let input: unknown = {}
            try {
              input = JSON.parse(Buffer.concat(chunks).toString() || '{}')
            } catch {
              /* an empty or broken body is the same as {} here */
            }
            const out = mockRpc(name, input, req.headers.cookie ?? '')
            send(out.status, out.body)
          })
          return
        }
        next()
      })
    },
  }
}

// The build lands inside the Go module so the binary can embed it; in
// development the Go server runs on :8080 and Vite proxies /api to it.
export default defineConfig({
  plugins: [react(), tailwindcss(), ...(MOCK ? [mockApi()] : [])],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: MOCK
      ? undefined
      : { '/api': { target: process.env.MPB_API ?? 'http://localhost:8080', changeOrigin: false } },
  },
  build: {
    outDir: '../server/assets/dist',
    // Not emptied: the folder keeps a .gitkeep so the Go embed compiles on a
    // bare checkout; `prebuild` clears the hashed assets instead.
    emptyOutDir: false,
    sourcemap: false,
  },
})
