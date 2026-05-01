import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // host: true binds to 0.0.0.0 so phones on the same LAN can hit
    // http://<pc-lan-ip>:5173. The /api proxy still resolves to the
    // backend on localhost (same dev box), so phone -> Vite -> uvicorn
    // works without exposing the API port directly.
    host: true,
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
})
