const API_BASE_URL = import.meta.env.PROD
  ? ''
  : (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '')

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {})
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  const response = await fetch(`${API_BASE_URL}${path}`, {
    credentials: 'include',
    ...options,
    headers,
    body: options.body && !(options.body instanceof FormData) ? JSON.stringify(options.body) : options.body,
  })
  if (response.status === 204) return null
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = Object.assign(
      new Error(data.error || data.message || 'The request could not be completed.'),
      { status: response.status },
    )
    throw error
  }
  return data
}

export const api = {
  request,
  auth: {
    getSession: () => request('/api/auth/get-session', { credentials: 'include' }),
    me: async () => {
      const session = await request('/api/auth/get-session', { credentials: 'include' })
      if (!session?.user) throw Object.assign(new Error('Authentication required'), { status: 401 })
      return { ...session.user, full_name: session.user.name }
    },
    signIn: ({ email, password }) => request('/api/auth/sign-in/email', { method: 'POST', body: { email, password } }),
    signUp: ({ name, email, password }) => request('/api/auth/sign-up/email', { method: 'POST', body: { name, email, password } }),
    signOut: () => request('/api/auth/sign-out', { method: 'POST', body: {} }),
    requestPasswordReset: ({ email, redirectTo }) => request('/api/auth/request-password-reset', { method: 'POST', body: { email, redirectTo } }),
    resetPassword: ({ newPassword, token }) => request('/api/auth/reset-password', { method: 'POST', body: { newPassword, token } }),
    updateProfile: (fullName) => request('/api/profile', { method: 'PATCH', body: { full_name: fullName } }),
    signInSocial: ({ provider, callbackURL }) => request('/api/auth/sign-in/social', { method: 'POST', body: { provider, callbackURL } }),
    verifyTotp: (code) => request('/api/auth/two-factor/verify-totp', { method: 'POST', body: { code } }),
    enableTotp: (password) => request('/api/auth/two-factor/enable', { method: 'POST', body: { password } }),
  },
  linkedin: {
    status: () => request('/api/linkedin/status'),
    disconnect: () => request('/api/linkedin/disconnect', { method: 'DELETE' }),
    post: ({ text, approved, approvalId = undefined }) => request('/api/linkedin/post', {
      method: 'POST',
      body: { text, approved, approvalId },
    }),
    comments: (postId) => request(`/api/linkedin/comments?${new URLSearchParams({ postId })}`),
    reply: ({ commentId, text, approved, approvalId }) => request('/api/linkedin/reply', {
      method: 'POST',
      body: { commentId, text, approved, approvalId },
    }),
    searchPeople: (query) => request(`/api/linkedin/search?${new URLSearchParams({ query })}`),
  },
  mcp: {
    list: () => request('/api/mcp/servers'),
    connect: ({ name, url, apiKey, headers }) => request('/api/mcp/servers', {
      method: 'POST',
      body: { name, url, api_key: apiKey, headers },
    }),
    tools: (id) => request(`/api/mcp/servers/${encodeURIComponent(id)}/tools`),
    setToolEnabled: (id, name, enabled) => request(
      `/api/mcp/servers/${encodeURIComponent(id)}/tools/${encodeURIComponent(name)}`,
      { method: 'PATCH', body: { enabled } },
    ),
    test: (id) => request(`/api/mcp/servers/${encodeURIComponent(id)}/test`, { method: 'POST', body: {} }),
    disconnect: (id) => request(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  settings: {
    get: () => request('/api/settings'),
    update: (preferences) => request('/api/settings', { method: 'PATCH', body: preferences }),
    keys: () => request('/api/settings/keys'),
    saveKey: ({ provider, apiKey }) => request('/api/settings/keys', {
      method: 'PUT',
      body: { provider, api_key: apiKey },
    }),
    deleteKey: (provider) => request(`/api/settings/keys/${encodeURIComponent(provider)}`, { method: 'DELETE' }),
    plan: () => request('/api/settings/plan'),
  },
  chat: (body) => request('/api/chat', { method: 'POST', body }),
  jobs: {
    get: (id, signal) => request(`/api/jobs/${encodeURIComponent(id)}`, { signal }),
    cancel: (id) => request(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} }),
  },
  approvals: {
    list: () => request('/api/approvals'),
    decide: (id, decision, rememberForWorkspace = false) => request(`/api/approvals/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: { decision, remember_for_workspace: rememberForWorkspace },
    }),
  },
  toolPermissions: {
    list: () => request('/api/tool-permissions'),
    revoke: (toolId) => request(`/api/tool-permissions/${encodeURIComponent(toolId)}`, { method: 'DELETE' }),
  },
  skills: {
    list: () => request('/api/skills'),
    /** @param {File} file @param {{ fallbackName?: string, ignoredFiles?: string[], supportingFiles?: Array<{ file: File, path: string }> }} [options] */
    install: (file, options = {}) => {
      const { fallbackName, ignoredFiles, supportingFiles } = options
      const body = new FormData()
      body.append('skill', file)
      if (fallbackName) body.append('skill_name', fallbackName)
      if (ignoredFiles?.length) body.append('ignored_files', JSON.stringify(ignoredFiles.slice(0, 20)))
      if (supportingFiles?.length) {
        body.append('supporting_paths', JSON.stringify(supportingFiles.map(({ path }) => path)))
        supportingFiles.forEach(({ file: supportingFile }) => body.append('supportingFiles', supportingFile))
      }
      return request('/api/skills/install', { method: 'POST', body })
    },
    setEnabled: (name, enabled) => request(`/api/skills/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: { enabled },
    }),
    remove: (name) => request(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    pendingApprovals: () => request('/api/skills/approvals'),
    decideApproval: (id, decision) => request(`/api/skills/approvals/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: { decision },
    }),
  },
  memories: {
    list: () => request('/api/memories'),
    update: (id, memory) => request(`/api/memories/${encodeURIComponent(id)}`, { method: 'PATCH', body: memory }),
    remove: (id) => request(`/api/memories/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    removeAll: () => request('/api/memories', { method: 'DELETE' }),
  },
  projects: {
    list: () => request('/api/projects'),
    get: (id) => request(`/api/projects/${encodeURIComponent(id)}`),
    create: (project) => request('/api/projects', { method: 'POST', body: project }),
    remove: (id) => request(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  tasks: {
    create: (task) => request('/api/tasks', { method: 'POST', body: task }),
    setStatus: (id, status) => request(`/api/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status } }),
  },
  conversations: {
    list: ({ search = '', cursor = null } = {}) => {
      const params = new URLSearchParams()
      if (search) params.set('search', search)
      if (cursor) params.set('cursor', cursor)
      return request(`/api/conversations?${params}`)
    },
    get: (id) => request(`/api/conversations/${encodeURIComponent(id)}`),
    messages: (id) => request(`/api/conversations/${encodeURIComponent(id)}/messages`),
    delete: (id) => request(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  upload: (file) => {
    const body = new FormData()
    body.append('file', file)
    return request('/api/files', { method: 'POST', body })
  },
}
