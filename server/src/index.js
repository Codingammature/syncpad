import { createApp } from './app.js'

const app = await createApp()

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    console.log(`${sig} received, flushing documents...`)
    await app.close()
    process.exit(0)
  })
}
