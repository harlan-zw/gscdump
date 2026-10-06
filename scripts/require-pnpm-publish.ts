// Each package's `prepublishOnly` runs this. The release workflow publishes
// with `--ignore-scripts`, so only a manual publish reaches it.
import process from 'node:process'
import { checkPublishAgent } from './publish-agent.ts'

const result = checkPublishAgent(process.env.npm_config_user_agent)
if (result._tag === 'Refused') {
  console.error(result.message)
  process.exitCode = 1
}
