import express from 'express'
import multer from 'multer'
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node'
import { auth } from '../auth/auth.js'
import { requireUser } from '../auth/session.js'
import { pool } from '../db/pool.js'
import { config } from '../config.js'
import { providerRegistry } from '../providers/registry.js'
import { deleteConversation, getConversation, getMessages, listConversations } from '../conversations/repository.js'
import { getOwnedFile, MAX_FILE_BYTES, saveUpload } from '../files/service.js'
import { cancelOwnedJob, getOwnedJob, submitChatJob } from '../jobs/service.js'
import { createMemory, deleteAllMemories, deleteMemory, listMemories, updateMemory } from '../memory/service.js'
import {
  createProject,
  createProjectTask,
  deleteProject,
  findProjectByName,
  findProjectMention,
  getProjectDetails,
  listProjects,
  parseCreateProjectRequest,
} from '../projects/service.js'
import { audit } from '../observability/audit.js'
import { log } from '../observability/logger.js'
import { requestContext } from '../observability/request-context.js'
import { decideApproval } from '../tools/executor.js'
import { getTool, parseApprovalDescription } from '../tools/registry.js'
import { registerWebSearchTool } from '../tools/web-search.js'
import { registerFileTools } from '../tools/file-tools.js'
import { registerMotionGraphicsTool } from '../tools/motion-graphics.js'
import { registerSkillCreateTool } from '../skills/skill-create.js'
import { extractSkillUpload, MAX_SKILL_UPLOAD_BYTES } from '../skills/archive.js'
import { normalizeSkillUpload } from '../skills/loader.js'
import { createCorsMiddleware } from './cors.js'
import {
  decideSkillApproval,
  installSkill,
  listSkillApprovals,
  listSkills,
  removeSkill,
  setSkillEnabled,
} from '../skills/service.js'
import { listToolPermissionGrants, revokeToolPermissionGrant } from '../tools/permissions.js'
import { createRateLimiter } from './rate-limit.js'
import {
  beginLinkedInConnect,
  completeLinkedInConnect,
  createLinkedInPost,
  disconnectLinkedIn,
  getLinkedInComments,
  getLinkedInStatus,
  replyToLinkedInComment,
  searchLinkedInPeople,
} from '../linkedin/service.js'
import { registerLinkedInTools } from '../linkedin/tools.js'
import {
  connectMcpServer,
  getMcpServerTools,
  listMcpServers,
  withUserMcpTools,
  refreshMcpServer,
  removeMcpServer,
  setMcpToolEnabled,
} from '../mcp/registry.js'
import {
  listSupportedApiKeyProviders,
  listUserApiKeys,
  removeUserApiKey,
  saveUserApiKey,
  withUserProviderRegistry,
} from '../settings/byok.js'
import { freeQuotaFailureMessage } from '../providers/fallback-chain.js'

const app = express()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1 } })
const skillUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SKILL_UPLOAD_BYTES, files: 9, fields: 3, fieldSize: 4096 },
})
const chatRateLimit = createRateLimiter({ limit: 10, windowMs: 60_000 })
registerWebSearchTool()
registerLinkedInTools()
registerFileTools()
registerMotionGraphicsTool()
registerSkillCreateTool()

app.disable('x-powered-by')
app.use(requestContext)
app.use('/api', createCorsMiddleware(config.webOrigin))
app.all('/api/auth/*', toNodeHandler(auth))
app.use(express.json({ limit: '1mb' }))

app.get('/api/health', async (_req, res, next) => {
  try {
    await pool.query('SELECT 1')
    res.json({ status: 'ok', database: 'ok' })
  } catch (error) {
    next(error)
  }
})

app.get('/api/linkedin/status', requireUser, async (req, res, next) => {
  try {
    res.json(await getLinkedInStatus({ userId: req.user.id }))
  } catch (error) {
    next(error)
  }
})

app.get('/api/linkedin/connect', requireUser, async (req, res, next) => {
  try {
    res.redirect(302, await beginLinkedInConnect({ userId: req.user.id }))
  } catch (error) {
    next(error)
  }
})

app.get('/api/linkedin/callback', requireUser, async (req, res, next) => {
  try {
    const result = await completeLinkedInConnect({
      userId: req.user.id,
      state: req.query.state,
      code: req.query.code,
      providerError: req.query.error,
    })
    const state = result.denied ? 'denied' : 'connected'
    res.redirect(302, `${config.webOrigin}/connections?linkedin=${state}`)
  } catch (error) {
    next(error)
  }
})

app.delete('/api/linkedin/disconnect', requireUser, async (req, res, next) => {
  try {
    await disconnectLinkedIn({ userId: req.user.id })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

app.get('/api/mcp/servers', requireUser, async (req, res, next) => {
  try {
    res.json({ items: await listMcpServers({ userId: req.user.id, database: pool }) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/mcp/servers', requireUser, requireObjectBody, async (req, res, next) => {
  try {
    const server = await connectMcpServer({
      userId: req.user.id,
      name: req.body.name,
      url: req.body.url,
      apiKey: req.body.api_key || '',
      headers: req.body.headers || {},
      database: pool,
    })
    res.status(201).json(server)
  } catch (error) {
    next(error)
  }
})

app.get('/api/mcp/servers/:serverId/tools', requireUser, async (req, res, next) => {
  try {
    res.json(await getMcpServerTools({
      userId: req.user.id,
      serverId: req.params.serverId,
      database: pool,
    }))
  } catch (error) {
    next(error)
  }
})

app.patch('/api/mcp/servers/:serverId/tools/:toolName', requireUser, requireObjectBody, async (req, res, next) => {
  try {
    res.json(await setMcpToolEnabled({
      userId: req.user.id,
      serverId: req.params.serverId,
      toolName: req.params.toolName,
      enabled: req.body.enabled,
      database: pool,
    }))
  } catch (error) {
    next(error)
  }
})

app.post('/api/mcp/servers/:serverId/test', requireUser, async (req, res, next) => {
  try {
    res.json(await refreshMcpServer({
      userId: req.user.id,
      serverId: req.params.serverId,
      database: pool,
    }))
  } catch (error) {
    next(error)
  }
})

app.delete('/api/mcp/servers/:serverId', requireUser, async (req, res, next) => {
  try {
    if (!await removeMcpServer({ userId: req.user.id, serverId: req.params.serverId, database: pool })) {
      return res.status(404).json({ error: 'MCP server was not found in Connections.' })
    }
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

app.post('/api/linkedin/post', requireUser, requireObjectBody, async (req, res, next) => {
  try {
    const result = await createLinkedInPost({
      userId: req.user.id,
      text: req.body.text,
      schedule: req.body.schedule,
      approved: req.body.approved,
      approvalId: req.body.approvalId,
    })
    res.status(result.preview ? 200 : 201).json(result)
  } catch (error) {
    next(error)
  }
})

app.get('/api/linkedin/comments', requireUser, async (req, res, next) => {
  try {
    res.json(await getLinkedInComments({ userId: req.user.id, postId: req.query.postId }))
  } catch (error) {
    next(error)
  }
})

app.get('/api/linkedin/search', requireUser, async (req, res, next) => {
  try {
    res.json(await searchLinkedInPeople({ userId: req.user.id, query: req.query.query }))
  } catch (error) {
    next(error)
  }
})

app.post('/api/linkedin/reply', requireUser, requireObjectBody, async (req, res, next) => {
  try {
    const result = await replyToLinkedInComment({
      userId: req.user.id,
      commentId: req.body.commentId,
      text: req.body.text,
      approved: req.body.approved,
      approvalId: req.body.approvalId,
    })
    res.status(result.preview ? 200 : 201).json(result)
  } catch (error) {
    next(error)
  }
})

app.get('/api/me', requireUser, (req, res) => {
  res.json({ ...req.user, full_name: req.user.name })
})

app.patch('/api/profile', requireUser, requireObjectBody, async (req, res, next) => {
  try {
    const fullName = typeof req.body.full_name === 'string' ? req.body.full_name.trim() : ''
    if (!fullName || fullName.length > 120) return res.status(400).json({ error: 'Name must be between 1 and 120 characters.' })
    const updated = await auth.api.updateUser({ headers: fromNodeHeaders(req.headers), body: { name: fullName } })
    res.json({ ...updated, full_name: updated.name })
  } catch (error) {
    next(error)
  }
})

app.get('/api/providers', requireUser, async (req, res, next) => {
  try {
    await withUserProviderRegistry({
      userId: req.user.id,
      database: pool,
      registry: providerRegistry,
    }, async (registry) => res.json({ providers: registry.list() }))
  } catch (error) {
    next(error)
  }
})

app.post('/api/providers/:providerId/test', requireUser, async (req, res, next) => {
  try {
    if (!['openrouter', 'gemini', 'workers_ai', 'groq', 'worker1'].includes(req.params.providerId)) {
      return res.status(404).json({ error: 'AI provider was not found.' })
    }
    const result = await withUserProviderRegistry({
      userId: req.user.id,
      database: pool,
      registry: providerRegistry,
    }, async (registry) => {
      const provider = registry.get(req.params.providerId)
      if (!provider) return {
        statusCode: 404,
        body: { error: 'AI provider was not found.' },
      }
      if (!provider.isAvailable) return {
        statusCode: 503,
        body: {
          provider: provider.id,
          status: 'failed',
          error: `${provider.name} is not configured in the server environment.`,
        },
      }
      const startedAt = Date.now()
      try {
        const completion = await provider.generate({
          messages: [{ role: 'user', content: 'Reply with exactly: connected' }],
          signal: AbortSignal.timeout(30_000),
        })
        return {
          statusCode: 200,
          provider: provider.id,
          body: {
            provider: provider.id,
            status: 'connected',
            latencyMs: Date.now() - startedAt,
            model: completion.model || provider.model || null,
          },
        }
      } catch (error) {
        return {
          statusCode: error.status && error.status !== 503 ? error.status : 503,
          body: {
            provider: provider.id,
            status: 'failed',
            upstreamStatus: error.upstreamStatus || null,
            error: freeQuotaFailureMessage(provider.id, error.upstreamStatus) ||
              error.message || 'The provider test failed.',
          },
        }
      }
    })
    res.status(result.statusCode).json(result.body)
  } catch (error) {
    next(error)
  }
})

app.get('/api/providers/:providerId/models', requireUser, async (req, res, next) => {
  try {
    const models = await providerRegistry.discoverModels(req.params.providerId)
    const provider = providerRegistry.get(req.params.providerId)
    for (const model of models) {
      await pool.query(
        `INSERT INTO models (id, provider_id, capabilities)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (provider_id, id) DO UPDATE SET capabilities = EXCLUDED.capabilities, discovered_at = now()`,
        [model, provider.id, JSON.stringify(provider.capabilities)],
      )
    }
    res.json({ models })
  } catch (error) {
    next(error)
  }
})

app.get('/api/conversations', requireUser, async (req, res, next) => {
  try {
    res.json(await listConversations({
      userId: req.user.id,
      search: typeof req.query.search === 'string' ? req.query.search.slice(0, 100) : '',
      cursor: decodeCursor(req.query.cursor),
      limit: req.query.limit,
    }))
  } catch (error) {
    next(error)
  }
})

app.get('/api/conversations/:conversationId', requireUser, async (req, res, next) => {
  try {
    if (!isUuid(req.params.conversationId)) return res.status(400).json({ error: 'The conversation ID is invalid.' })
    const conversation = await getConversation({ userId: req.user.id, conversationId: req.params.conversationId })
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' })
    res.json(conversation)
  } catch (error) {
    next(error)
  }
})

app.get('/api/conversations/:conversationId/messages', requireUser, async (req, res, next) => {
  try {
    if (!isUuid(req.params.conversationId)) return res.status(400).json({ error: 'The conversation ID is invalid.' })
    const conversation = await getConversation({ userId: req.user.id, conversationId: req.params.conversationId })
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' })
    res.json({ items: await getMessages({ userId: req.user.id, conversationId: req.params.conversationId, limit: req.query.limit }) })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/conversations/:conversationId', requireUser, async (req, res, next) => {
  try {
    if (!isUuid(req.params.conversationId)) return res.status(400).json({ error: 'The conversation ID is invalid.' })
    const deleted = await deleteConversation({ userId: req.user.id, conversationId: req.params.conversationId })
    if (!deleted) return res.status(404).json({ error: 'Conversation not found.' })
    await audit({ userId: req.user.id, event: 'conversation.deleted', resourceType: 'conversation', resourceId: req.params.conversationId })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

app.post('/api/files', requireUser, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'A file is required.' })
    res.status(201).json(await saveUpload({ userId: req.user.id, file: req.file }))
  } catch (error) {
    next(error)
  }
})

app.get('/api/files/:fileId', requireUser, async (req, res, next) => {
  try {
    if (!isUuid(req.params.fileId)) return res.status(400).json({ error: 'The file ID is invalid.' })
    const file = await getOwnedFile({ userId: req.user.id, fileId: req.params.fileId })
    if (!file) return res.status(404).json({ error: 'File not found.' })
    res.set({
      'Content-Type': file.mime_type,
      'Content-Length': file.size_bytes,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.original_name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    })

    file.stream.on('error', next)
    file.stream.pipe(res)
  } catch (error) {
    next(error)
  }
})

app.get('/api/files/:fileId/preview', requireUser, async (req, res, next) => {
  try {
    if (!isUuid(req.params.fileId)) return res.status(400).json({ error: 'The file ID is invalid.' })
    const file = await getOwnedFile({ userId: req.user.id, fileId: req.params.fileId })
    if (!file) return res.status(404).json({ error: 'File not found.' })
    if (file.mime_type !== 'text/html') return res.status(415).json({ error: 'Only HTML files can be previewed.' })
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': file.size_bytes,
      'Content-Disposition': 'inline',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    })
    file.stream.on('error', next)
    file.stream.pipe(res)
  } catch (error) {
    next(error)
  }
})

app.post('/api/chat', requireUser, chatRateLimit, requireObjectBody, async (req, res, next) => {
  try {
    const message = typeof req.body.message === 'string' ? req.body.message.trim().slice(0, 8000) : ''
    const timezone = typeof req.body.timezone === 'string' && req.body.timezone.length <= 100
      ? req.body.timezone
      : 'UTC'
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone })
    } catch {
      return res.status(400).json({ error: 'The timezone is invalid.' })
    }
    let projectId = req.body.project_id ?? null
    const conversationId = req.body.conversation_id ?? null
    if (projectId !== null && !isUuid(projectId)) {
      return res.status(400).json({ error: 'The project ID is invalid.' })
    }
    if (conversationId !== null && !isUuid(conversationId)) {
      return res.status(400).json({ error: 'The conversation ID is invalid.' })
    }
    if (conversationId) {
      const { rows } = await pool.query(
        'SELECT project_id FROM conversations WHERE id = $1 AND user_id = $2',
        [conversationId, req.user.id],
      )
      if (!rows[0]) return res.status(404).json({ error: 'Conversation not found.' })
      if (projectId && rows[0].project_id && projectId !== rows[0].project_id) {
        return res.status(409).json({ error: 'Conversation belongs to a different project.' })
      }
      projectId = projectId || rows[0].project_id
    }
    if (projectId) {
      const { rowCount } = await pool.query(
        'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
        [projectId, req.user.id],
      )
      if (!rowCount) return res.status(404).json({ error: 'Project not found.' })
    }
    if (!conversationId && !projectId) {
      const requestedProjectName = parseCreateProjectRequest(message)
      if (requestedProjectName) {
        const existing = await findProjectByName({ userId: req.user.id, name: requestedProjectName })
        const project = existing || await createProject({ userId: req.user.id, name: requestedProjectName })
        projectId = project.id
      } else {
        const mentionedProject = await findProjectMention({ userId: req.user.id, message })
        projectId = mentionedProject?.id || null
      }
    }
    const attachments = Array.isArray(req.body.attachments)
      ? req.body.attachments.slice(0, 5).filter((file) => file && typeof file.name === 'string' && typeof file.url === 'string')
      : []
    if (!message && !attachments.length) return res.status(400).json({ error: 'A message or attachment is required.' })
    const job = await submitChatJob({
      userId: req.user.id,
      conversationId,
      projectId,
      message,
      attachments,
      requestId: req.requestId,
      timezone,
    })
    res.status(202).json({ job_id: job.id, status: job.status, progress: job.progress })
  } catch (error) {
    next(error)
  }
})

app.get('/api/jobs/:jobId', requireUser, async (req, res, next) => {
  try {
    if (!isUuid(req.params.jobId)) return res.status(400).json({ error: 'The job ID is invalid.' })
    const job = await getOwnedJob({ userId: req.user.id, jobId: req.params.jobId })
    if (!job) return res.status(404).json({ error: 'Job not found.' })
    res.json(job)
  } catch (error) {
    next(error)
  }
})

app.post('/api/jobs/:jobId/cancel', requireUser, async (req, res, next) => {
  try {
    if (!isUuid(req.params.jobId)) return res.status(400).json({ error: 'The job ID is invalid.' })
    const cancelled = await cancelOwnedJob({ userId: req.user.id, jobId: req.params.jobId })
    if (!cancelled) return res.status(404).json({ error: 'Job not found.' })
    const job = await getOwnedJob({ userId: req.user.id, jobId: req.params.jobId })
    res.status(job.status === 'running' ? 202 : 200).json(job)
  } catch (error) {
    next(error)
  }
})

app.get('/api/memories', requireUser, async (req, res, next) => {
  try {
    res.json({ items: await listMemories(req.user.id) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/memories', requireUser, requireObjectBody, async (req, res, next) => {
  try {
    if (typeof req.body.source !== 'string' || !req.body.source.trim()) return res.status(400).json({ error: 'A memory source is required.' })
    const projectId = req.body.project_id ?? null
    if (projectId !== null && !isUuid(projectId)) return res.status(400).json({ error: 'The project ID is invalid.' })
    res.status(201).json(await createMemory({
      userId: req.user.id, kind: req.body.kind ?? req.body.type, content: req.body.content,
      source: req.body.source.trim(), projectId,
    }))
  } catch (error) {
    next(error)
  }
})

app.delete('/api/memories/:memoryId', requireUser, async (req, res, next) => {
  try {
    if (!isUuid(req.params.memoryId)) return res.status(400).json({ error: 'The memory ID is invalid.' })
    if (!await deleteMemory(req.user.id, req.params.memoryId)) return res.status(404).json({ error: 'Memory not found.' })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

app.patch('/api/memories/:memoryId', requireUser, requireObjectBody, async (req, res, next) => {
  try {
    if (!isUuid(req.params.memoryId)) return res.status(400).json({ error: 'The memory ID is invalid.' })
    const projectId = req.body.project_id === undefined
      ? undefined
      : req.body.project_id === null ? null : req.body.project_id
    if (projectId !== undefined && projectId !== null && !isUuid(projectId)) {
      return res.status(400).json({ error: 'The project ID is invalid.' })
    }
    const memory = await updateMemory({
      userId: req.user.id,
      memoryId: req.params.memoryId,
      kind: req.body.kind ?? req.body.type,
      content: req.body.content,
      projectId,
    })
    if (!memory) return res.status(404).json({ error: 'Memory not found.' })
    res.json(memory)
  } catch (error) {
    next(error)
  }
})

app.delete('/api/memories', requireUser, async (req, res, next) => {
  try {
    const deleted = await deleteAllMemories(req.user.id)
    res.json({ deleted })
  } catch (error) {
    next(error)
  }
})

app.get('/api/projects', requireUser, async (req, res, next) => {
  try {
    res.json({ items: await listProjects(req.user.id) })
  } catch (error) {
    next(error)
  }
})

app.get('/api/projects/:projectId', requireUser, async (req, res, next) => {
  try {
    if (!isUuid(req.params.projectId)) return res.status(400).json({ error: 'The project ID is invalid.' })
    const project = await getProjectDetails({ userId: req.user.id, projectId: req.params.projectId })
    if (!project) return res.status(404).json({ error: 'Project not found.' })
    res.json(project)
  } catch (error) {
    next(error)
  }
})

app.delete('/api/projects/:projectId', requireUser, async (req, res, next) => {
  try {
    if (!isUuid(req.params.projectId)) return res.status(400).json({ error: 'The project ID is invalid.' })
    if (!await deleteProject({ userId: req.user.id, projectId: req.params.projectId })) {
      return res.status(404).json({ error: 'Project not found.' })
    }
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

app.get('/api/tasks', requireUser, async (req, res, next) => {
  try {
    const projectId = typeof req.query.project_id === 'string' ? req.query.project_id : null
    if (projectId !== null && !isUuid(projectId)) return res.status(400).json({ error: 'The project ID is invalid.' })
    if (req.query.project_id !== undefined && projectId === null) return res.status(400).json({ error: 'The project ID is invalid.' })
    const { rows } = await pool.query(
      `SELECT id, project_id, title, description, status, dependencies, position, created_at, updated_at
       FROM tasks WHERE user_id = $1 AND ($2::uuid IS NULL OR project_id = $2)
       ORDER BY position, created_at`,
      [req.user.id, projectId],
    )
    res.json({ items: rows })
  } catch (error) {
    next(error)
  }
})

app.patch('/api/tasks/:taskId', requireUser, requireObjectBody, async (req, res, next) => {
  try {
    if (!isUuid(req.params.taskId)) return res.status(400).json({ error: 'The task ID is invalid.' })
    const status = req.body.status
    if (!['pending', 'completed', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Unsupported task status.' })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const task = await client.query('SELECT id, dependencies FROM tasks WHERE id = $1 AND user_id = $2 FOR UPDATE', [req.params.taskId, req.user.id])
      if (!task.rowCount) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'Task not found.' })
      }
      if (status === 'completed' && task.rows[0].dependencies.length) {
        const dependencies = await client.query(
          `SELECT count(*)::int AS total FROM tasks
           WHERE user_id = $1 AND id = ANY($2::uuid[]) AND status = 'completed'`,
          [req.user.id, task.rows[0].dependencies],
        )
        if (dependencies.rows[0].total !== task.rows[0].dependencies.length) {
          await client.query('ROLLBACK')
          return res.status(409).json({ error: 'Complete task dependencies before completing this task.' })
        }
      }
      const updated = await client.query(
        'UPDATE tasks SET status = $2, updated_at = now() WHERE id = $1 RETURNING id, project_id, title, description, status, dependencies, position, updated_at',
        [req.params.taskId, status],
      )
      await client.query('COMMIT')
      res.json(updated.rows[0])
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  } catch (error) {
    next(error)
  }
})

app.get('/api/settings', requireUser, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT preferences FROM user_settings WHERE user_id = $1', [req.user.id])
    res.json({ preferences: rows[0]?.preferences || {} })
  } catch (error) {
    next(error)
  }
})

app.patch('/api/settings', requireUser, requireObjectBody, async (req, res, next) => {
  try {
    const { theme } = req.body
    if (theme !== undefined && !['dark', 'light', 'system'].includes(theme)) {
      return res.status(400).json({ error: 'Theme must be dark, light, or system.' })
    }
    const { rows } = await pool.query(
      `INSERT INTO user_settings (user_id, preferences)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (user_id) DO UPDATE SET preferences = user_settings.preferences || EXCLUDED.preferences, updated_at = now()
       RETURNING preferences`,
      [req.user.id, JSON.stringify({ ...(theme ? { theme } : {}) })],
    )
    res.json({ preferences: rows[0].preferences })
  } catch (error) {
    next(error)
  }
})

app.get('/api/settings/keys', requireUser, async (req, res, next) => {
  try {
    res.json({
      providers: listSupportedApiKeyProviders(),
      ...(await listUserApiKeys({ userId: req.user.id, database: pool })),
    })
  } catch (error) {
    next(error)
  }
})

app.put('/api/settings/keys', requireUser, requireObjectBody, async (req, res, next) => {
  try {
    res.json(await saveUserApiKey({
      userId: req.user.id,
      providerId: req.body.provider,
      apiKey: req.body.api_key,
      database: pool,
    }))
  } catch (error) {
    next(error)
  }
})

app.delete('/api/settings/keys/:provider', requireUser, async (req, res, next) => {
  try {
    if (!await removeUserApiKey({ userId: req.user.id, providerId: req.params.provider, database: pool })) {
      return res.status(404).json({ error: 'That API key was not found.' })
    }
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

app.get('/api/settings/plan', requireUser, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT plan FROM user_plans WHERE user_id = $1', [req.user.id])
    const { hasOwnKey } = await listUserApiKeys({ userId: req.user.id, database: pool })
    res.json({ plan: rows[0]?.plan || 'free', hasOwnKey })
  } catch (error) {
    next(error)
  }
})

app.post('/api/projects', requireUser, requireObjectBody, async (req, res, next) => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : ''
    if (!name || name.length > 160) return res.status(400).json({ error: 'Project name must be between 1 and 160 characters.' })
    const description = req.body.description ?? ''
    if (typeof description !== 'string' || description.length > 8000) {
      return res.status(400).json({ error: 'Project description must be a string of up to 8000 characters.' })
    }
    res.status(201).json(await createProject({ userId: req.user.id, name, description }))
  } catch (error) {
    next(error)
  }
})

app.post('/api/tasks', requireUser, requireObjectBody, async (req, res, next) => {
  try {
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : ''
    if (!title || title.length > 240) return res.status(400).json({ error: 'Task title must be between 1 and 240 characters.' })
    const projectId = req.body.project_id ?? null
    if (projectId !== null && !isUuid(projectId)) return res.status(400).json({ error: 'The project ID is invalid.' })
    if (req.body.dependencies !== undefined && !Array.isArray(req.body.dependencies)) {
      return res.status(400).json({ error: 'Task dependencies are invalid.' })
    }
    const dependencies = req.body.dependencies || []
    if (dependencies.length > 50 || dependencies.some((id) => !isUuid(id))) return res.status(400).json({ error: 'Task dependencies are invalid.' })
    if (req.body.description !== undefined && typeof req.body.description !== 'string') {
      return res.status(400).json({ error: 'Task description must be a string.' })
    }
    res.status(201).json(await createProjectTask({
      userId: req.user.id, projectId, title,
      description: typeof req.body.description === 'string' ? req.body.description.slice(0, 8000) : '',
      dependencies,
    }))
  } catch (error) {
    next(error)
  }
})

app.get('/api/approvals', requireUser, async (req, res, next) => {
  try {
    await withUserMcpTools({ userId: req.user.id, database: pool }, async () => {
      const { rows } = await pool.query(
        `SELECT a.id, a.tool_execution_id, a.description, a.expires_at, a.created_at,
                e.tool_id, e.input AS tool_input, j.id AS job_id, j.conversation_id
         FROM approval_requests a
         JOIN tool_executions e ON e.id = a.tool_execution_id
         LEFT JOIN jobs j ON j.agent_run_id = e.agent_run_id AND j.approval_id = a.id
         WHERE a.user_id = $1 AND a.status = 'pending' AND a.expires_at > now()
         ORDER BY a.created_at`,
        [req.user.id],
      )
      res.json({
        items: rows.map(({ tool_input, ...row }) => ({
          ...row,
          description: parseApprovalDescription(row.description)?.description || 'This approval record is stale and requires review.',
          tool_name: getTool(row.tool_id)?.name || row.tool_id,
          connector: getTool(row.tool_id)?.connector || 'unknown',
          ...(row.tool_id === 'file_write' ? { input: parseStoredObject(tool_input) } : {}),
        })),
      })
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/tool-permissions', requireUser, async (req, res, next) => {
  try {
    res.json({ items: await listToolPermissionGrants({ userId: req.user.id }) })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/tool-permissions/:toolId', requireUser, async (req, res, next) => {
  try {
    if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(req.params.toolId)) {
      return res.status(400).json({ error: 'The tool ID is invalid.' })
    }
    const revoked = await revokeToolPermissionGrant({ userId: req.user.id, toolId: req.params.toolId })
    if (!revoked) return res.status(404).json({ error: 'Tool permission grant not found.' })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

app.get('/api/skills', requireUser, async (req, res, next) => {
  try {
    res.json({ items: await listSkills({ userId: req.user.id, database: pool }) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/skills/install', requireUser, skillUpload.fields([{ name: 'skill', maxCount: 1 }, { name: 'supportingFiles', maxCount: 8 }]), async (req, res, next) => {
  try {
    const skillFile = req.files?.skill?.[0]
    if (!skillFile) return res.status(400).json({ error: 'Upload a SKILL.md file or a ZIP containing one.' })
    const extracted = extractSkillUpload(skillFile)
    const fallbackName = typeof req.body.skill_name === 'string' ? req.body.skill_name : extracted.fallbackName
    const markdown = normalizeSkillUpload(extracted.markdown, fallbackName)
    const extraFiles = parseIgnoredSkillFiles(req.body.ignored_files)
    const ignoredFiles = [...extracted.ignoredFiles, ...extraFiles].slice(0, 20)
    const ignoredFileCount = extracted.ignoredFileCount + extraFiles.length
    const uploadedSupport = req.files?.supportingFiles || []
    const supportingPaths = parseSupportingSkillPaths(req.body.supporting_paths, uploadedSupport.length)
    if (extracted.supportingFiles.length && uploadedSupport.length) {
      return res.status(400).json({ error: 'Choose a ZIP upload or a folder upload, not both.' })
    }
    const supportingFiles = extracted.supportingFiles.length
      ? extracted.supportingFiles
      : uploadedSupport.map((file, index) => ({ path: supportingPaths[index], content: file.buffer }))
    const warnings = ignoredFileCount
      ? [`Ignored unknown files: ${ignoredFiles.join(', ')}${ignoredFileCount > ignoredFiles.length ? ` and ${ignoredFileCount - ignoredFiles.length} more` : ''}`]
      : []
    const result = await installSkill({ userId: req.user.id, markdown, supportingFiles, database: pool, source: 'upload' })
    res.status(result.status === 'pending_approval' ? 202 : result.status === 'installed' ? 201 : 200).json({
      ...result,
      warnings,
      supportingFilesCount: supportingFiles.length,
    })
  } catch (error) {
    next(error)
  }
})

app.patch('/api/skills/:name', requireUser, requireObjectBody, async (req, res, next) => {
  try {
    const result = await setSkillEnabled({
      userId: req.user.id,
      name: req.params.name,
      enabled: req.body.enabled,
      database: pool,
    })
    res.status(result.status === 'pending_approval' ? 202 : 200).json(result)
  } catch (error) {
    next(error)
  }
})

app.delete('/api/skills/:name', requireUser, async (req, res, next) => {
  try {
    await removeSkill({ userId: req.user.id, name: req.params.name, database: pool })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

app.get('/api/skills/approvals', requireUser, async (req, res, next) => {
  try {
    res.json({ items: await listSkillApprovals({ userId: req.user.id, database: pool }) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/skills/approvals/:approvalId', requireUser, requireObjectBody, async (req, res, next) => {
  try {
    if (!isUuid(req.params.approvalId)) return res.status(400).json({ error: 'The skill approval ID is invalid.' })
    if (!['approved', 'denied'].includes(req.body.decision)) {
      return res.status(400).json({ error: 'Decision must be approved or denied.' })
    }
    res.json(await decideSkillApproval({
      userId: req.user.id,
      approvalId: req.params.approvalId,
      decision: req.body.decision,
      database: pool,
    }))
  } catch (error) {
    next(error)
  }
})

app.post('/api/approvals/:approvalId', requireUser, requireObjectBody, async (req, res, next) => {
  try {
    if (!isUuid(req.params.approvalId)) return res.status(400).json({ error: 'The approval ID is invalid.' })
    if (!['approved', 'denied'].includes(req.body.decision)) return res.status(400).json({ error: 'Approval decision must be approved or denied.' })
    if (req.body.remember_for_workspace !== undefined && typeof req.body.remember_for_workspace !== 'boolean') {
      return res.status(400).json({ error: 'remember_for_workspace must be a boolean.' })
    }
    const approvalResult = await withUserMcpTools({ userId: req.user.id, database: pool }, () => decideApproval({
      userId: req.user.id,
      approvalId: req.params.approvalId,
      decision: req.body.decision,
      requestId: req.requestId,
      deferExecution: true,
      rememberForWorkspace: req.body.remember_for_workspace === true,
    }))
    const execution = await pool.query(
      `SELECT e.agent_run_id, r.input->'continuation' AS continuation
       FROM approval_requests a
       JOIN tool_executions e ON e.id = a.tool_execution_id
       JOIN agent_runs r ON r.id = e.agent_run_id AND r.user_id = a.user_id
       WHERE a.id = $1 AND a.user_id = $2`,
      [req.params.approvalId, req.user.id],
    )
    const stored = execution.rows[0]
    if (!stored) return res.status(404).json({ error: 'Approval request not found.' })

    let job = await pool.query(
      `UPDATE jobs SET status = 'queued', agent_run_id = $2, approval_id = $3,
           progress = '{"stage":"queued","message":"Approval recorded; waiting for a worker."}'::jsonb,
           lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
           completed_at = NULL, updated_at = now()
       WHERE user_id = $1 AND agent_run_id = $2 AND status = 'waiting_approval'
       RETURNING id, status, conversation_id`,
      [req.user.id, stored.agent_run_id, req.params.approvalId],
    )
    let queuedJob = job.rows[0]
    if (!queuedJob) {
      const existing = await pool.query(
        `SELECT id, status, conversation_id FROM jobs
         WHERE user_id = $1 AND approval_id = $2 ORDER BY created_at DESC LIMIT 1`,
        [req.user.id, req.params.approvalId],
      )
      queuedJob = existing.rows[0]
    }
    if (!queuedJob) {
      if (approvalResult.status === 'completed') {
        return res.json({ approval: approvalResult, job_id: null, status: 'completed' })
      }
      const continuation = stored.continuation
      if (!continuation || typeof continuation.conversationId !== 'string' || typeof continuation.request !== 'string') {
        return res.status(409).json({ error: 'This approval has no recoverable job continuation.' })
      }
      const created = await pool.query(
        `INSERT INTO jobs (user_id, status, input, conversation_id, agent_run_id, approval_id, progress)
         VALUES ($1, 'queued', $2::jsonb, $3, $4, $5,
           '{"stage":"queued","message":"Approval recorded; waiting for a worker."}'::jsonb)
         RETURNING id, status, conversation_id`,
        [
          req.user.id,
          JSON.stringify({
            message: continuation.request,
            conversation_id: continuation.conversationId,
            project_id: continuation.projectId || null,
            attachments: [],
            request_id: req.requestId,
          }),
          continuation.conversationId,
          stored.agent_run_id,
          req.params.approvalId,
        ],
      )
      queuedJob = created.rows[0]
    }
    res.status(202).json({ approval: approvalResult, job_id: queuedJob.id, status: queuedJob.status, conversation_id: queuedJob.conversation_id })
  } catch (error) {
    next(error)
  }
})

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const fileLimit = _req.path.startsWith('/api/skills')
      ? `${MAX_SKILL_UPLOAD_BYTES / (1024 * 1024)} MiB`
      : `${MAX_FILE_BYTES / (1024 * 1024)} MB`
    return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
      error: error.code === 'LIMIT_FILE_SIZE' ? `Files must be ${fileLimit} or smaller.` : 'The upload was invalid.',
      requestId: _req.requestId,
    })
  }
  const status = Number(error.status) >= 400 && Number(error.status) < 500 ? Number(error.status) : 500
  if (status >= 500) {
    log('error', 'api.request.failed', {
      requestId: _req.requestId,
      error: {
        name: error.name || 'Error',
        code: error.code || null,
        provider: error.provider || null,
        upstreamStatus: error.upstreamStatus || null,
        message: error.message || 'Unknown error',
      },
    })
  }
  res.status(status).json({
    error: status < 500 ? error.message : 'The server could not complete the request.',
    requestId: _req.requestId,
  })
})

function decodeCursor(value) {
  if (typeof value !== 'string' || value.length > 512) return null
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (typeof cursor.updatedAt === 'string' && typeof cursor.id === 'string') return cursor
  } catch {
    return null
  }
  return null
}

function isUuid(value) {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
}

function requireObjectBody(req, res, next) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'A JSON request body is required.', requestId: req.requestId })
  }
  next()
}

function parseStoredObject(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
}

function parseIgnoredSkillFiles(value) {
  if (value === undefined) return []
  let files
  try {
    files = JSON.parse(value)
  } catch {
    throw Object.assign(new Error('Folder upload metadata is invalid. Please select the folder again.'), { status: 400 })
  }
  if (!Array.isArray(files) || files.length > 20 ||
    files.some((file) => typeof file !== 'string' || file.length > 512)) {
    throw Object.assign(new Error('Folder upload metadata is invalid. Please select the folder again.'), { status: 400 })
  }
  return files.map((file) => file.replace(/[\u0000-\u001f]/g, '').slice(0, 200))
}

function parseSupportingSkillPaths(value, fileCount) {
  if (!fileCount) return []
  let paths
  try {
    paths = JSON.parse(value)
  } catch {
    throw Object.assign(new Error('Skill supporting-file metadata is invalid. Select the folder again.'), { status: 400 })
  }
  if (!Array.isArray(paths) || paths.length !== fileCount ||
    paths.some((item) => typeof item !== 'string' || item.length > 512)) {
    throw Object.assign(new Error('Skill supporting-file metadata is invalid. Select the folder again.'), { status: 400 })
  }
  return paths
}

export default app
