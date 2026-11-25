import pg from 'pg'
import { config } from '../config.js'
import { log } from '../observability/logger.js'

const { Pool } = pg

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.DB_POOL_SIZE || 10),
  ...(process.env.PGSSLMODE === 'require' ? { ssl: { rejectUnauthorized: true } } : {}),
})

pool.on('error', (error) => {
  log('error', 'database.pool.error', {
    error: { name: error.name || 'Error', message: error.message || 'Unexpected pool error.' },
  })
})
