import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { pool } from './pool.js'
import { log } from '../observability/logger.js'

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

export async function migrate(database = pool) {
  await database.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort()
  for (const name of files) {
    const alreadyApplied = await database.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name])
    if (alreadyApplied.rowCount) continue

    const sql = await readFile(path.join(migrationsDir, name), 'utf8')
    const client = await database.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name])
      await client.query('COMMIT')
      log('info', 'database.migration.applied', { migration: name })
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate()
    .catch((error) => {
      log('error', 'database.migration.failed', {
        error: { name: error.name || 'Error', message: error.message || 'Unknown migration error.' },
      })
      process.exitCode = 1
    })
    .finally(() => pool.end())
}
