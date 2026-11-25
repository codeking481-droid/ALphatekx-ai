import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getTool, listTools, parseApprovalDescription, serializeApprovalDescription } from './registry.js'
import { registerFileTools } from './file-tools.js'

async function withTools(run) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'alphatekx-file-tools-'))
  const workspaceDir = path.join(temporaryDirectory, 'workspace')
  const userId = `user-${randomUUID()}`
  const unregister = registerFileTools({ workspaceDir })
  try {
    await run({ workspaceDir, userId, temporaryDirectory })
  } finally {
    unregister()
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

function userWorkspace(workspaceDir, userId) {
  const userHash = createHash('sha256').update(userId).digest('hex')
  return path.join(workspaceDir, 'users', userHash)
}

test('file_write creates nested workspace files and file_read returns their text', async () => {
  await withTools(async ({ workspaceDir, userId }) => {
    const written = await getTool('file_write').execute({
      userId,
      input: { path: 'site/index.html', content: '<button>Hello AlphaTekx</button>' },
    })
    const read = await getTool('file_read').execute({ userId, input: { path: 'site/index.html' } })

    assert.equal(written.action, 'created')
    assert.equal(written.path, 'site/index.html')
    assert.equal(read.content, '<button>Hello AlphaTekx</button>')
    assert.equal(read.bytes, Buffer.byteLength(read.content))
    assert.equal(await readFile(path.join(userWorkspace(workspaceDir, userId), 'site', 'index.html'), 'utf8'), read.content)
    const updated = await getTool('file_write').execute({
      userId,
      input: { path: 'site/index.html', content: '<button>Hello AlphaTekx!</button>' },
    })
    assert.equal(updated.action, 'updated')
    assert.equal((await getTool('file_read').execute({ userId, input: { path: 'site/index.html' } })).content, '<button>Hello AlphaTekx!</button>')
  })
})

test('file_list hides secret paths and file tools are isolated per user', async () => {
  await withTools(async ({ workspaceDir, userId }) => {
    const userRoot = userWorkspace(workspaceDir, userId)
    await mkdir(userRoot, { recursive: true })
    await writeFile(path.join(userRoot, '.env'), 'TOKEN=private')
    await writeFile(path.join(userRoot, 'notes.txt'), 'visible')
    const listing = await getTool('file_list').execute({ userId, input: {} })

    assert.deepEqual(listing.entries.map((entry) => entry.name), ['notes.txt'])
    await assert.rejects(
      getTool('file_read').execute({ userId: 'different-user', input: { path: 'notes.txt' } }),
      (error) => error.status === 404,
    )
    await assert.rejects(
      getTool('file_read').execute({ userId, input: { path: '.env' } }),
      /may contain secrets/,
    )
  })
})

test('workspace paths reject traversal, absolute paths, and symlink escapes', async (t) => {
  await withTools(async ({ workspaceDir, userId, temporaryDirectory }) => {
    const fileRead = getTool('file_read')
    for (const unsafePath of ['../outside.txt', '.. /outside.txt', 'C:\\outside.txt', '\\\\server\\share\\secret.txt', 'file.txt:secret']) {
      await assert.rejects(fileRead.execute({ userId, input: { path: unsafePath } }))
    }

    const outsideDirectory = path.join(temporaryDirectory, 'outside')
    await mkdir(outsideDirectory)
    await writeFile(path.join(outsideDirectory, 'data.txt'), 'outside')
    const userRoot = userWorkspace(workspaceDir, userId)
    await mkdir(userRoot, { recursive: true })
    try {
      await symlink(outsideDirectory, path.join(userRoot, 'outside'), 'junction')
    } catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
        t.skip('This Windows environment does not permit creating symlinks.')
        return
      }
      throw error
    }
    await assert.rejects(
      fileRead.execute({ userId, input: { path: 'outside/data.txt' } }),
      /Symbolic links/,
    )
  })
})

test('file_write is approval-gated and internal tool metadata is not exposed to model plans', async () => {
  await withTools(async () => {
    const tools = Object.fromEntries(listTools().map((tool) => [tool.id, tool]))
    assert.equal(getTool('file_write').requiresApproval, true)
    assert.equal(getTool('file_write').permissions.includes('tool:approved'), true)
    assert.equal(getTool('file_write').approvalScope.startsWith('workspace:'), true)
    assert.match(
      parseApprovalDescription(serializeApprovalDescription(
        getTool('file_write'),
        { path: 'site/index.html', content: '<button>Hi</button>' },
      )).description,
      /site\/index\.html/,
    )
    assert.equal(Object.hasOwn(tools.file_write, 'approvalScope'), false)
    assert.equal(tools.file_read.requiresApproval, false)
    assert.equal(tools.file_list.requiresApproval, false)
    assert.equal(getTool('file_write').validate({ path: '../outside.txt', content: 'blocked' }), false)
    assert.equal(getTool('file_write').validate({ path: '.env', content: 'blocked' }), false)
  })
})

test('file_write audit metadata records the path, size, and content hash without duplicating source text', async () => {
  await withTools(async () => {
    const tool = getTool('file_write')
    const details = tool.auditDetails({ path: 'site/index.html', content: '<h1>Hello</h1>' })
    assert.deepEqual(Object.keys(details).sort(), ['bytes', 'path', 'sha256'])
    assert.equal(details.bytes, Buffer.byteLength('<h1>Hello</h1>'))
    assert.equal(details.sha256, createHash('sha256').update('<h1>Hello</h1>').digest('hex'))
    assert.equal(Object.hasOwn(details, 'content'), false)
  })
})
