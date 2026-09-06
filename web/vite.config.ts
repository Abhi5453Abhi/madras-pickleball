import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// The build lands inside the Go module so the binary can embed it; in
// development the Go server runs on :8080 and Vite proxies /api to it.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.MPB_API ?? 'http://localhost:8080', changeOrigin: false } },
  },
  build: {
    outDir: '../server/assets/dist',
    // Not emptied: the folder keeps a .gitkeep so the Go embed compiles on a
    // bare checkout; `prebuild` clears the hashed assets instead.
    emptyOutDir: false,
    sourcemap: false,
  },
})
