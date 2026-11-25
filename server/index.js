import { validateConfig, config } from './config.js'

validateConfig()
const [
  { default: app },
  { pool },
  { providerRegistry },
  { syncAgentDefinitions, syncProviderCatalog },
  { syncToolDefinitions },
  { initializeSkills },
  { log },
] = await Promise.all([
  import('./http/app.js'),
  import('./db/pool.js'),
  import('./providers/registry.js'),
  import('./providers/sync.js'),
  import('./tools/sync.js'),
  import('./skills/service.js'),
  import('./observability/logger.js'),
])
try {
  await pool.query('SELECT 1')
  await initializeSkills()
  await syncProviderCatalog(providerRegistry)
  await syncAgentDefinitions()
  await syncToolDefinitions()
  app.listen(config.port, '0.0.0.0', () => {
    log('info', 'api.started', { port: config.port, nodeEnv: config.nodeEnv })
  })
} catch (error) {
  log('error', 'api.startup.failed', {
    error: { name: error.name || 'Error', message: error.message || 'Database bootstrap failed.' },
  })
  await pool.end()
  process.exitCode = 1
}
