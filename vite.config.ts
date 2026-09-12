import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { listamScraperPlugin } from './server/vite-plugin-scraper.js'

export default defineConfig({
  plugins: [react(), listamScraperPlugin()],
  server: {
    port: 5174,
    strictPort: true,
  },
})
