import { existsSync } from 'node:fs'
import { MAIN_ENTRY } from './app.js'

export default function globalSetup(): void {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(`${MAIN_ENTRY} not found. Run \`pnpm build\` before \`pnpm e2e\`.`)
  }
}
