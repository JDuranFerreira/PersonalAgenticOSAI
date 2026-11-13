import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // PDF.js is isolated in a lazy-loaded chunk for PDF attachments.
    chunkSizeWarningLimit: 550,
  },
  server: {
    port: 5174,
    strictPort: true,
    // External edits (agents writing files outside the editor) are missed by
    // the default watcher on this Windows setup — poll so Vite always sees them.
    watch: {
      usePolling: true,
      interval: 300,
    },
  },
})
