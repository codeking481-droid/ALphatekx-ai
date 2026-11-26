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
import { withUserMcpTools } from './mcp/registry.js'
import { withUserProviderRegistry } from './settings/byok.js'
import { publishDueLinkedInPosts } from './linkedin/scheduler.js'

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

const worker = createJobWorker({
  database: pool,
  registry: providerRegistry,
  withUserContext: ({ userId, database }, operation) => withUserMcpTools(
    { userId, database },
    () => withUserProviderRegistry({ userId, database, registry: providerRegistry }, operation),
  ),
})
let stopping = false
let scheduledPostsBusy = false
const processScheduledPosts = async () => {
  if (scheduledPostsBusy || stopping) return
  scheduledPostsBusy = true
  try {
    const result = await publishDueLinkedInPosts({ database: pool })
    if (result.published || result.failed) log('info', 'linkedin.scheduled_posts.processed', result)
  } catch (error) {
    log('error', 'linkedin.scheduled_posts.failed', { error: { name: error.name, message: error.message } })
  } finally {
    scheduledPostsBusy = false
  }
}
await processScheduledPosts()
const scheduledPostsTimer = setInterval(processScheduledPosts, 30_000)
scheduledPostsTimer.unref()
const shutdown = () => {
  if (stopping) return
  stopping = true
  clearInterval(scheduledPostsTimer)
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
