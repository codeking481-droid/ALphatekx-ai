import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createSearchWorkerEnv, getSearchWorkerLaunchOptions, runIsolatedWebSearch } from './isolated-web-search.js'
import { searchTavily } from './runtime/tavily-search.mjs'
import { getTool } from './registry.js'
import { registerWebSearchTool } from './web-search.js'

test('web_search is a bounded, approval-gated read tool', () => {
  const unregister = registerWebSearchTool()
  try {
    const tool = getTool('web_search')
    assert.equal(tool.requiresApproval, true)
    assert.equal(tool.retrySafe, true)
    assert.deepEqual(tool.permissions, ['tool:approved'])
    assert.equal(tool.validate({ query: 'latest research', max_results: 5 }), true)
    assert.equal(tool.validate({ query: 'latest research', max_results: 6 }), false)
  } finally {
    unregister()
  }
})

test('Tavily search sends bounded queries and returns only safe HTTPS results', async () => {
  let request
  const result = await searchTavily({
    apiKey: 'test-tavily-key',
    query: '  current AI research  ',
    maxResults: 9,
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) }
      return {
        ok: true,
        async json() {
          return {
            results: [
              { title: 'Research', url: 'https://example.com/paper', content: 'Summary', score: 0.9 },
              { title: 'Insecure', url: 'http://example.com/', content: 'Not allowed' },
              { title: 'Credentials', url: 'https://user:pass@example.com/', content: 'Not allowed' },
            ],
          }
        },
      }
    },
  })

  assert.equal(request.url, 'https://api.tavily.com/search')
  assert.equal(request.options.method, 'POST')
  assert.equal(request.body.api_key, 'test-tavily-key')
  assert.equal(request.body.query, 'current AI research')
  assert.equal(request.body.max_results, 5)
  assert.equal(request.body.include_answer, false)
  assert.deepEqual(result.results.map((item) => item.title), ['Research'])
  assert.equal(result.results[0].url, 'https://example.com/paper')
})

test('Tavily errors are explicit and invalid queries never make a request', async () => {
  let requests = 0
  await assert.rejects(
    searchTavily({ apiKey: 'test-key', query: ' ', fetchImpl: async () => { requests += 1 } }),
    /query is invalid/,
  )
  await assert.rejects(
    searchTavily({
      apiKey: 'test-key',
      query: 'query',
      fetchImpl: async () => {
        requests += 1
        return { ok: false, status: 429 }
      },
    }),
    /HTTP 429/,
  )
  assert.equal(requests, 1)
})

test('isolated search child receives no application or model-provider secrets', () => {
  const sourceEnv = {
    SystemRoot: 'C:\\Windows',
    DATABASE_URL: 'database-secret',
    BETTER_AUTH_SECRET: 'auth-secret',
    OPENAI_API_KEY: 'model-secret',
    TAVILY_API_KEY: 'search-secret',
  }
  const env = createSearchWorkerEnv(sourceEnv.TAVILY_API_KEY, 'win32', sourceEnv)
  const options = getSearchWorkerLaunchOptions(sourceEnv.TAVILY_API_KEY, 'win32', sourceEnv)

  assert.deepEqual(env, { TAVILY_API_KEY: 'search-secret', SystemRoot: 'C:\\Windows' })
  assert.deepEqual(options.env, env)
  assert.match(options.cwd, /server[\\/]tools[\\/]runtime$/)
  assert.ok(options.execArgv.some((argument) => argument.startsWith('--allow-fs-read=')))
})

test('isolated search runner returns worker results through IPC', async () => {
  const priorKey = process.env.TAVILY_API_KEY
  process.env.TAVILY_API_KEY = 'test-key'
  let launch
  try {
    const result = await runIsolatedWebSearch({
      query: 'AlphaTekx',
      maxResults: 2,
      timeoutMs: 1000,
      forkProcess: (file, args, options) => {
        launch = { file, args, options }
        const child = new EventEmitter()
        child.kill = () => {}
        child.send = (message) => {
          assert.deepEqual(message, { query: 'AlphaTekx', maxResults: 2 })
          setImmediate(() => child.emit('message', {
            type: 'result',
            result: { provider: 'tavily', query: 'AlphaTekx', results: [] },
          }))
        }
        return child
      },
    })
    assert.equal(result.provider, 'tavily')
    assert.match(launch.file, /web-search-worker\.mjs$/)
    assert.deepEqual(launch.args, [])
    assert.equal(launch.options.env.TAVILY_API_KEY, 'test-key')
    assert.equal(Object.hasOwn(launch.options.env, 'OPENAI_API_KEY'), false)
  } finally {
    if (priorKey === undefined) delete process.env.TAVILY_API_KEY
    else process.env.TAVILY_API_KEY = priorKey
  }
})

test('restricted search subprocess starts and rejects invalid input without network access', async () => {
  const file = fileURLToPath(new URL('./runtime/web-search-worker.mjs', import.meta.url))
  const child = fork(file, [], getSearchWorkerLaunchOptions('test-key'))
  const message = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Isolated search subprocess did not respond.'))
    }, 5000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('message', (result) => {
      clearTimeout(timer)
      resolve(result)
    })
    child.once('exit', (code) => {
      if (code !== 0) {
        clearTimeout(timer)
        reject(new Error(`Isolated search subprocess exited with code ${code}.`))
      }
    })
    child.send({ query: '', maxResults: 1 })
  })
  assert.deepEqual(message, { type: 'error', message: 'The web search query is invalid.' })
})
