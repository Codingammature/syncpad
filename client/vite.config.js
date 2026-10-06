import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev: the API/WebSocket server runs on :4000 (npm run dev in /server).
export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ['yjs', 'y-protocols', 'lib0', 'y-prosemirror'] }, // two Yjs copies break editors
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
      '/collab': { target: 'ws://localhost:4000', ws: true },
    },
  },
})
