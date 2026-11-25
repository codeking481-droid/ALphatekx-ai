import { audit } from '../observability/audit.js'
import { containsSensitiveMemoryData } from './service.js'

export function extractDurableMemories(message) {
  if (typeof message !== 'string' || !message.trim()) return []
  const candidates = []
  const sentences = message.match(/[^.!?\n]+(?:[.!?]+|$)/g) || [message]
  for (const sentence of sentences) {
    const clauses = sentence.split(/,(?=\s*(?:I\b|my\b|we\b|our\b))/i)
    for (const rawClause of clauses) {
      const clause = rawClause.trim().replace(/[.!?]+$/, '').trim()
      if (!clause || clause.length > 280 || containsSensitiveMemoryData(clause)) continue
      const preference = /^(?:I|we)\s+(like|prefer|enjoy|dislike|avoid)\s+(.+)$/i.exec(clause)
      const project = /^(?:my|our)\s+(?:business|project)\s+is\s+(.+)$/i.exec(clause) ||
        /^(?:I am|I'm|we are|we're)\s+(?:building|developing|working on|launching|creating)\s+(.+)$/i.exec(clause)
      const fact = /^(?:I|we)\s+(sell|work as|work in|specialize in|specialise in)\s+(.+)$/i.exec(clause)
      const name = /^(?:my name is|call me)\s+(.+)$/i.exec(clause)
      const lesson = /^(?:I|we)\s+(?:learned|learnt)(?:\s+that)?\s+(.+)$/i.exec(clause)
      const outcome = /^what\s+(worked|failed)(?:\s+for me)?\s*(?::|is|was)?\s+(.+)$/i.exec(clause)

      if (preference) {
        const verb = preference[1].toLowerCase() === 'like' ? 'Likes'
          : preference[1].toLowerCase() === 'prefer' ? 'Prefers'
            : preference[1].toLowerCase() === 'enjoy' ? 'Enjoys'
              : preference[1].toLowerCase() === 'dislike' ? 'Dislikes' : 'Avoids'
        candidates.push({ kind: 'preference', content: `${verb} ${preference[2].trim()}` })
      } else if (project) {
        const prefix = /^(?:my|our)\s+business/i.test(project[0]) ? 'Business'
          : /^(?:my|our)\s+project/i.test(project[0]) ? 'Project' : 'Working on'
        candidates.push({ kind: 'project', content: `${prefix}: ${project[1].trim()}` })
      } else if (fact) {
        const verb = fact[1].toLowerCase() === 'sell' ? 'Sells'
          : fact[1].toLowerCase() === 'work as' ? 'Works as'
            : fact[1].toLowerCase() === 'work in' ? 'Works in' : 'Specializes in'
        candidates.push({ kind: 'fact', content: `${verb} ${fact[2].trim()}` })
      } else if (name) {
        candidates.push({ kind: 'fact', content: `Name: ${name[1].trim()}` })
      } else if (lesson) {
        candidates.push({ kind: 'lesson-learned', content: `Learned: ${lesson[1].trim()}` })
      } else if (outcome) {
        const label = outcome[1][0].toUpperCase() + outcome[1].slice(1).toLowerCase()
        candidates.push({ kind: 'lesson-learned', content: `${label}: ${outcome[2].trim()}` })
      }
    }
  }
  const unique = new Map()
  for (const candidate of candidates) {
    const content = candidate.content.replace(/\s+/g, ' ').trim().slice(0, 280)
    if (!content || containsSensitiveMemoryData(content)) continue
    unique.set(`${candidate.kind}:${content.toLowerCase()}`, { kind: candidate.kind, content })
  }
  return [...unique.values()]
}

export async function saveAutomaticMemories({ userId, message, projectId = null, database }) {
  if (!database || typeof database.query !== 'function') throw new TypeError('Automatic memories require a database client.')
  const candidates = extractDurableMemories(message)
  const saved = []
  for (const memory of candidates) {
    const memoryProjectId = memory.kind === 'preference' ? null : projectId
    const existing = await database.query(
      `SELECT id FROM memory_records
       WHERE user_id = $1 AND project_id IS NOT DISTINCT FROM $2
         AND kind = $3 AND lower(content) = lower($4)
       LIMIT 1`,
      [userId, memoryProjectId, memory.kind, memory.content],
    )
    if (existing.rowCount) continue
    const { rows } = await database.query(
      `INSERT INTO memory_records (user_id, kind, content, source, project_id)
       VALUES ($1, $2, $3, 'chat:auto', $4)
       RETURNING id, kind, content, source, project_id, created_at`,
      [userId, memory.kind, memory.content, memoryProjectId],
    )
    if (rows[0]) saved.push(rows[0])
  }
  if (saved.length) {
    await audit({
      userId,
      event: 'memory.auto_saved',
      resourceType: 'memory',
      details: { count: saved.length, kinds: [...new Set(saved.map(({ kind }) => kind))] },
    }, database)
  }
  return saved
}
