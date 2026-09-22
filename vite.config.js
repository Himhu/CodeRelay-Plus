import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { monitorPlugin } from './server/monitor-api.js'
import { randomUUID } from 'node:crypto'

export default defineConfig(({ command }) => {
  const build = command === 'build' ? randomUUID() : ''
  return { define: { __SIGNAL_BUILD__: JSON.stringify(build) }, plugins: [react(), monitorPlugin(), {
    name: 'console-build-version',
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build }) }) },
  }] }
})
