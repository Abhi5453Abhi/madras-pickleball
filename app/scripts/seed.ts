import 'dotenv/config'
import { seed } from './seed-core'

seed()
  .then(() => {
    console.log('\nSeed complete. Change these passwords at first login.')
    process.exit(0)
  })
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
