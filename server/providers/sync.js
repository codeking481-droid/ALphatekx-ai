import { pool } from '../db/pool.js'
import { AGENT_DEFINITIONS } from '../agents/definitions.js'

export async function syncProviderCatalog(registry, database = pool) {
  for (const provider of registry.list()) {
    await database.query(
      `INSERT INTO ai_providers (id, display_name, adapter, capabilities, enabled)
       VALUES ($1, $2, $3, $4::jsonb, TRUE)
       ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name,
         adapter = EXCLUDED.adapter, capabilities = EXCLUDED.capabilities, enabled = TRUE, updated_at = now()`,
      [provider.id, provider.name, provider.id, JSON.stringify({ ...provider.capabilities, configured: provider.available })],
    )
    await database.query(
      `INSERT INTO provider_configurations (provider_id, selected_model, settings)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (provider_id) DO UPDATE SET selected_model = EXCLUDED.selected_model,
         settings = EXCLUDED.settings, updated_at = now()`,
      [provider.id, provider.model, JSON.stringify({ qualityScore: provider.qualityScore, latencyScore: provider.latencyScore, costScore: provider.costScore })],
    )
    if (provider.model) {
      await database.query(
        `INSERT INTO models (id, provider_id, capabilities)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (provider_id, id) DO UPDATE SET capabilities = EXCLUDED.capabilities, discovered_at = now()`,
        [provider.model, provider.id, JSON.stringify(provider.capabilities)],
      )
    }
  }
}

export async function syncAgentDefinitions(database = pool) {
  for (const agent of AGENT_DEFINITIONS) {
    await database.query(
      `INSERT INTO agent_definitions (id, name, role, permissions, enabled)
       VALUES ($1, $2, $3, $4::jsonb, TRUE)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role,
         permissions = EXCLUDED.permissions, enabled = TRUE`,
      [agent.id, agent.name, agent.role, JSON.stringify(agent.permissions)],
    )
  }
}
