import { validateWorkerConfig } from './config.js'
import { pool } from './db/pool.js'
import { providerRegistry } from './providers/registry.js'
import { syncAgentDefinitions, syncProviderCatalog } from './providers/sync.js'
import { recoverStaleExecutions } from './tools/executor.js'
import { syncToolDefinitions } from './tools/sync.js'
import { registerWebSearchTool } from './tools/web-search.js'
import { registerFileTools } from './tools/file-tools.js'
import { registerSkillCreateTool } from './skills/skill-create.js'
import { registerLinkedInTools } from './linkedin/tools.js'
import { initializeSkills } from './skills/service.js'
import { recoverStaleJobs } from './jobs/service.js'
import { createJobWorker } from './jobs/worker.js'
import { log } from './observability/logger.js'

validateWorkerConfig()
registerWebSearchTool()
registerLinkedInTools()
registerFileTools()
registerSkillCreateTool()
await initializeSkills()
await pool.query('SELECT 1')
await syncProviderCatalog(providerRegistry)
await syncAgentDefinitions()
await syncToolDefinitions()
log('info', 'job.recovery.completed', await recoverStaleJobs({ database: pool }))
log('info', 'execution.recovery.completed', await recoverStaleExecutions({ database: pool }))
if (!process.env.TAVILY_API_KEY) {
  log('warn', 'tool.web_search.unconfigured', { message: 'TAVILY_API_KEY is not set; web_search will fail explicitly until configured.' })
}

const worker = createJobWorker({ database: pool, registry: providerRegistry })
let stopping = false
const shutdown = () => {
  if (stopping) return
  stopping = true
  worker.stop()
  log('info', 'job.worker.stopping', { workerId: worker.workerId })
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

log('info', 'job.worker.started', { workerId: worker.workerId })
try {
  await worker.start()
} catch (error) {
  log('error', 'job.worker.failed', { error: { name: error.name, message: error.message } })
  process.exitCode = 1
} finally {
  await pool.end()
}
