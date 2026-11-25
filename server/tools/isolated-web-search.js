import { fork } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const runtimeDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runtime')
const workerPath = path.join(runtimeDirectory, 'web-search-worker.mjs')
const DEFAULT_TIMEOUT_MS = 18_000

export function createSearchWorkerEnv(apiKey, platform = process.platform, sourceEnv = process.env) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('TAVILY_API_KEY is not configured on the server.')
  }
  const env = { TAVILY_API_KEY: apiKey }
  if (platform === 'win32' && sourceEnv.SystemRoot) env.SystemRoot = sourceEnv.SystemRoot
  return env
}

export function getSearchWorkerLaunchOptions(apiKey, platform = process.platform, sourceEnv = process.env) {
  const readPermission = `--allow-fs-read=${runtimeDirectory}`
  const permissionFlag = process.allowedNodeEnvironmentFlags?.has('--permission')
    ? '--permission'
    : '--experimental-permission'
  return {
    cwd: runtimeDirectory,
    env: createSearchWorkerEnv(apiKey, platform, sourceEnv),
    execArgv: [permissionFlag, readPermission],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  }
}

export function runIsolatedWebSearch({ query, maxResults, signal, timeoutMs = DEFAULT_TIMEOUT_MS, forkProcess = fork }) {
  const apiKey = process.env.TAVILY_API_KEY
  const child = forkProcess(workerPath, [], getSearchWorkerLaunchOptions(apiKey))

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      if (error) {
        child.kill()
        reject(error)
      } else {
        resolve(value)
      }
    }
    const onAbort = () => finish(signal.reason || new Error('Search was cancelled.'))
    const timeout = setTimeout(() => {
      finish(Object.assign(new Error(`Web search timed out after ${timeoutMs} ms.`), { code: 'TOOL_TIMEOUT' }))
    }, timeoutMs)

    child.once('error', (error) => finish(error))
    child.once('exit', (code) => {
      if (!settled) finish(new Error(`Isolated web search worker exited unexpectedly (${code}).`))
    })
    child.on('message', (message) => {
      if (message?.type === 'result') finish(null, message.result)
      else if (message?.type === 'error') finish(new Error(message.message || 'Web search failed.'))
    })
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.send({ query, maxResults })
  })
}
