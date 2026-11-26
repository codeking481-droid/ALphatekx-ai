import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import { getTool, listTools } from '../tools/registry.js'
import { log } from '../observability/logger.js'

export const MAX_SKILL_BYTES = 256 * 1024
const VALID_PERMISSIONS = new Set(['tool:read', 'tool:approved'])
const DANGEROUS_TOOLS = new Set(['file_write', 'skill_create', 'run_code', 'shell'])
const BUILTIN_TOOL_IDS = new Set(['web_search', 'file_read', 'file_list', 'file_write'])
const DEFAULT_SKILL_TOOL_IDS = new Set(['web_search', 'file_read', 'file_list'])
const SKILL_CREATION_TYPES = new Set(['text', 'file', 'animation'])
const MATCH_STOP_WORDS = new Set([
  'a', 'about', 'an', 'and', 'can', 'create', 'do', 'for', 'from', 'generate', 'help', 'i',
  'in', 'make', 'me', 'my', 'of', 'on', 'please', 'the', 'to', 'with', 'write', 'you',
])
const TEXT_ASSET_EXTENSIONS = new Set([
  '.csv', '.css', '.html', '.js', '.jsx', '.json', '.md', '.py', '.sh', '.svg', '.ts',
  '.tsx', '.txt', '.xml', '.yaml', '.yml',
])
const INLINE_IMAGE_EXTENSIONS = new Set(['.gif', '.ico', '.jpeg', '.jpg', '.png', '.webp'])

export function parseSkillMarkdown(markdown) {
  try {
    return parseSkillMarkdownContent(markdown)
  } catch (error) {
    if (error.status) throw error
    throw Object.assign(error, { status: 400 })
  }
}

function parseSkillMarkdownContent(markdown) {
  if (typeof markdown !== 'string' || Buffer.byteLength(markdown, 'utf8') > MAX_SKILL_BYTES) {
    throw new Error(`SKILL.md must be UTF-8 text no larger than ${MAX_SKILL_BYTES} bytes.`)
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(markdown)
  if (!match) throw new Error('SKILL.md must begin with a YAML frontmatter block.')

  const frontmatter = parseFrontmatter(match[1])
  const allowedFields = new Set(['name', 'description', 'version', 'permissions', 'tools', 'creates', 'keywords'])
  if (Object.keys(frontmatter).some((key) => !allowedFields.has(key))) {
    throw new Error('SKILL.md frontmatter contains an unsupported field.')
  }
  const { name, description, version, permissions, tools } = frontmatter
  const keywords = normalizeKeywords(frontmatter.keywords)
  if (keywords.length !== (frontmatter.keywords || []).length || keywords.length > 20) {
    throw new Error('Skill keywords must contain no more than 20 non-empty values.')
  }
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new Error('Skill name must be a lowercase hyphenated slug.')
  }
  if (typeof description !== 'string' || !description.trim() || description.length > 300) {
    throw new Error('Skill description must be non-empty and no longer than 300 characters.')
  }
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(version)) {
    throw new Error('Skill version must use semantic version format, such as 1.0.0.')
  }
  if (!Array.isArray(tools) || tools.length > 12 || new Set(tools).size !== tools.length) {
    throw new Error('Skill tools must list no more than 12 unique registered tool IDs.')
  }
  for (const id of tools) {
    if (typeof id !== 'string' || !getTool(id)) {
      throw new Error(`Skill requests an unavailable tool: ${String(id)}.`)
    }
  }
  if (!Array.isArray(permissions) || new Set(permissions).size !== permissions.length ||
    permissions.some((permission) => !VALID_PERMISSIONS.has(permission))) {
    throw new Error('Skill permissions must list unique supported permissions.')
  }
  const requiredPermissions = new Set(tools.flatMap((id) => getTool(id).permissions))
  if (permissions.length !== requiredPermissions.size ||
    permissions.some((permission) => !requiredPermissions.has(permission))) {
    throw new Error('Skill permissions must exactly match the permissions required by its allowed tools.')
  }

  const body = match[2].trim()
  return {
    name,
    description: description.trim(),
    version,
    permissions: [...permissions],
    tools: [...tools],
    keywords,
    creates: normalizeCreationTypes(frontmatter.creates, `${name} ${description} ${body}`),
    body,
    markdown,
    dangerous: tools.some((id) => DANGEROUS_TOOLS.has(id)),
  }
}

export function normalizeSkillUpload(markdown, fallbackName = 'uploaded-skill') {
  if (typeof markdown !== 'string' || Buffer.byteLength(markdown, 'utf8') > MAX_SKILL_BYTES) {
    throw Object.assign(new Error(`SKILL.md must be UTF-8 text no larger than ${MAX_SKILL_BYTES} bytes.`), { status: 413 })
  }

  const source = markdown.replace(/^\uFEFF/, '')
  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)
  let frontmatter = {}
  if (frontmatterMatch) {
    try {
      frontmatter = parseUploadFrontmatter(frontmatterMatch[1])
    } catch {
      frontmatter = {}
    }
  }

  const body = extractUploadBody(source, frontmatterMatch)
  const name = skillSlug(frontmatter.name) || skillSlug(fallbackName) || 'uploaded-skill'
  const description = normalizeDescription(frontmatter.description, body, name)
  const version = typeof frontmatter.version === 'string' &&
    /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(frontmatter.version)
    ? frontmatter.version
    : '1.0.0'
  const keywords = normalizeKeywords(frontmatter.keywords)
  const tools = normalizeUploadTools(frontmatter.tools, `${name} ${description} ${body}`)
  const creates = normalizeCreationTypes(frontmatter.creates, `${name} ${description} ${body}`)
  const permissions = [...new Set(tools.flatMap((id) => getTool(id).permissions))]
  const instructions = body || "Use this skill when it is relevant to the user's request."
  const yaml = [
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    `version: ${version}`,
    ...(keywords.length ? ['keywords:', ...keywords.map((keyword) => `  - ${JSON.stringify(keyword)}`)] : []),
    'permissions:',
    ...permissions.map((permission) => `  - ${permission}`),
    'tools:',
    ...tools.map((id) => `  - ${id}`),
    'creates:',
    ...creates.map((type) => `  - ${type}`),
  ].join('\n')

  return `---\n${yaml}\n---\n\n${instructions}\n`
}

function parseUploadFrontmatter(source) {
  const result = {}
  const lines = source.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#') || /^\s/.test(rawLine)) continue
    const field = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]*(.*))?$/.exec(rawLine)
    if (!field) throw new Error('Malformed frontmatter.')
    const key = field[1].toLowerCase()
    let value = field[2] || ''
    if (key === 'description' && /^[>|][+-]?$/.test(value.trim())) {
      const style = value.trim()[0]
      const block = []
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
        block.push(lines[++index].trim())
      }
      value = style === '>' ? block.join(' ') : block.join('\n')
      result[key] = value
    } else if (['tools', 'permissions', 'creates', 'keywords'].includes(key)) {
      const values = []
      if (!value.trim()) {
        while (index + 1 < lines.length) {
          const item = /^\s+-\s*(.*?)\s*$/.exec(lines[index + 1])
          if (!item) break
          values.push(parseUploadScalar(item[1]))
          index += 1
        }
      } else {
        const inline = /^\[(.*)\]$/.exec(value.trim())
        values.push(...(inline ? inline[1].split(',') : value.split(','))
          .map((item) => parseUploadScalar(item.trim())))
      }
      result[key] = values
    } else if (['name', 'description', 'version'].includes(key)) {
      result[key] = parseUploadScalar(value.trim())
    }
  }
  return result
}

function parseUploadScalar(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'")
  return value.trim()
}

function extractUploadBody(source, frontmatterMatch) {
  if (frontmatterMatch) return source.slice(frontmatterMatch[0].length).trim()
  const lines = source.split(/\r?\n/)
  if (lines[0]?.trim() === '---') {
    const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
    if (closing >= 0) return lines.slice(closing + 1).join('\n').trim()
    const separator = lines.findIndex((line, index) => index > 0 && !line.trim())
    return (separator >= 0 ? lines.slice(separator + 1) : lines.slice(1)).join('\n').trim()
  }
  return source.trim()
}

function normalizeDescription(value, body, name) {
  const candidate = typeof value === 'string' ? value.trim() : ''
  if (candidate) return candidate.slice(0, 300)
  const firstLine = body.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || ''
  const fromBody = firstLine.replace(/^#{1,6}\s*/, '').slice(0, 300)
  return fromBody || `Uploaded guidance for ${name.replace(/-/g, ' ')}.`
}

function normalizeUploadTools(value, context = '') {
  const requested = Array.isArray(value) ? value : []
  const usable = [...new Set(requested
    .filter((id) => typeof id === 'string')
    .map((id) => id.trim())
    .filter((id) => {
      const tool = getTool(id)
      return tool && tool.permissions.every((permission) => VALID_PERMISSIONS.has(permission))
    }))]
  const defaults = listTools()
    .filter(({ id }) => DEFAULT_SKILL_TOOL_IDS.has(id))
    .map(({ id }) => id)
  const inferred = inferSkillTools(context)
  return [...new Set([...(usable.length ? usable : defaults), ...inferred])].slice(0, 12)
}

function inferSkillTools(context) {
  const available = new Set(listTools().map(({ id }) => id))
  const inferred = []
  if (/\b(html|animation|animated|motion graphics|gif|video|birthday card|logo animation)\b/i.test(context) &&
    available.has('motion_graphics_create')) {
    inferred.push('motion_graphics_create')
  }
  if (/\b(linkedin|social media post)\b/i.test(context) && available.has('linkedin_post')) {
    inferred.push('linkedin_post')
  }
  return inferred
}

function normalizeKeywords(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0 && item.length <= 80))]
}

function skillSlug(value) {
  if (typeof value !== 'string') return ''
  return value.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
}

export function parseFrontmatter(source) {
  const result = {}
  let activeList = null
  for (const rawLine of source.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue
    const listItem = /^\s+-\s+(.+?)\s*$/.exec(rawLine)
    if (listItem) {
      if (!activeList) throw new Error('Frontmatter list item has no field.')
      result[activeList].push(parseScalar(listItem[1]))
      continue
    }
    const field = /^([a-z_]+):(?:\s*(.*))?$/.exec(rawLine)
    if (!field) throw new Error('Skill frontmatter must use simple YAML key/value fields and lists.')
    if (Object.hasOwn(result, field[1])) throw new Error(`Duplicate frontmatter field: ${field[1]}.`)
    activeList = ['permissions', 'tools', 'creates', 'keywords'].includes(field[1]) && !field[2]
      ? field[1]
      : null
    result[field[1]] = activeList ? [] : parseScalar(field[2] || '')
  }
  return result
}

export function matchSkill(message, skills, {
  history = [],
  activeSkill = null,
  preserveActiveSkill = false,
} = {}) {
  if (preserveActiveSkill && activeSkill) {
    const activeName = typeof activeSkill === 'string' ? activeSkill : activeSkill.name
    const active = skills.find((skill) => skill.enabled && skill.name === activeName)
    if (active) return active
  }
  const requestTokens = new Set([...tokenize(message)].filter((token) => !MATCH_STOP_WORDS.has(token)))
  if (!requestTokens.size) return null
  const contextTokens = new Set(history
    .filter((item) => item?.role === 'user' || item?.role === 'assistant')
    .map((item) => item.content || '')
    .join(' ')
    .split(/\s+/)
    .flatMap((word) => [...tokenize(word)])
    .filter((token) => !MATCH_STOP_WORDS.has(token)))
  let best = null
  let bestScore = 0
  const requestIntent = inferIntent(message)
  for (const skill of skills) {
    if (!skill.enabled) continue
    const fields = [
      { value: skill.name.replace(/-/g, ' '), weight: 4 },
      { value: Array.isArray(skill.keywords) ? skill.keywords.join(' ') : '', weight: 3 },
      { value: skill.description, weight: 2.5 },
      { value: String(skill.body || '').slice(0, 6000), weight: 0.75 },
    ]
    let score = 0
    const matchedTokens = new Set()
    for (const { value, weight } of fields) {
      const fieldTokens = tokenize(value)
      for (const token of requestTokens) {
        if (fieldTokens.has(token)) {
          score += weight * (token.length >= 7 ? 1.2 : 1)
          matchedTokens.add(token)
        }
      }
      for (const token of contextTokens) {
        if (fieldTokens.has(token) && !requestTokens.has(token)) score += weight * 0.1
      }
    }
    if (requestIntent && requestIntent === inferIntent(`${skill.name} ${skill.description} ${(skill.keywords || []).join(' ')} ${skill.body || ''}`)) {
      score += 1.5
    }
    if (score < 4.5 || (matchedTokens.size < 2 && ![...matchedTokens].some((token) => token.length >= 7))) continue
    if (score > bestScore) {
      best = skill
      bestScore = score
    }
  }
  return best
}

export function getUserSkillsDirectory(userId, skillsDir = config.skillsDir) {
  if (typeof userId !== 'string' || !userId.trim()) throw new TypeError('A user ID is required for personal skills.')
  const userHash = createHash('sha256').update(userId).digest('hex')
  return path.join(skillsDir, 'users', userHash)
}

export function getSkillAllowedTools(skill, fallback = false) {
  if (skill?.tools?.length) return [...skill.tools]
  if (skill) return listTools().filter(({ id }) => DEFAULT_SKILL_TOOL_IDS.has(id)).map(({ id }) => id)
  return fallback ? listTools().filter(({ id }) => BUILTIN_TOOL_IDS.has(id)).map(({ id }) => id) : []
}

export async function initializeSkillLoader({ skillsDir = config.skillsDir } = {}) {
  await mkdir(skillsDir, { recursive: true })
  const root = await lstat(skillsDir)
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('The skills root must be a real directory.')
  const results = await scanDirectory(skillsDir, { includeUserFolders: true })
  log('info', 'skills.loader.initialized', { validSkills: results.valid, invalidSkills: results.invalid })
  return results
}

export async function getAvailableSkills({ userId, database, skillsDir = config.skillsDir } = {}) {
  if (!userId) throw new TypeError('A user ID is required to list skills.')
  await mkdir(skillsDir, { recursive: true })
  const root = await lstat(skillsDir)
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('The skills root must be a real directory.')

  const bundled = await scanDirectory(skillsDir, { skipUsers: true, skillsDir })
  const personalRoot = getUserSkillsDirectory(userId, skillsDir)
  const usersDirectory = path.join(skillsDir, 'users')
  if (await existingSafeDirectory(usersDirectory)) await existingSafeDirectory(personalRoot)
  const personal = await scanDirectory(personalRoot, { skillsDir, missingOk: true })
  const { rows } = await database.query(
    'SELECT name, enabled, source FROM user_skills WHERE user_id = $1',
    [userId],
  )
  const enabledByName = new Map(rows.map((row) => [row.name, row.enabled]))
  const sourceByName = new Map(rows.map((row) => [row.name, row.source]))
  const skills = []
  for (const skill of bundled.skills) {
    const builtin = skill.name === 'create-skill'
    const enabledByDefault = builtin || ['manage-linkedin', 'motion-graphics'].includes(skill.name)
    skills.push({
      ...skill,
      builtin,
      bundled: !builtin,
      source: 'Biz',
      enabled: builtin || (enabledByName.has(skill.name)
        ? enabledByName.get(skill.name) === true
        : enabledByDefault),
    })
  }
  const bundledNames = new Set(skills.map(({ name }) => name))
  for (const skill of personal.skills) {
    if (bundledNames.has(skill.name)) {
      log('error', 'skills.loader.duplicate_skill_name', { name: skill.name })
      continue
    }
    skills.push({
      ...skill,
      builtin: false,
      bundled: false,
      source: sourceByName.get(skill.name) === 'biz' ? 'Biz' : 'Uploaded',
      enabled: enabledByName.get(skill.name) === true,
    })
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name))
}

export async function existingSafeDirectory(directory) {
  try {
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Skills directory must be a real directory.')
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

export async function scanDirectory(directory, {
  includeUserFolders = false,
  skipUsers = false,
  missingOk = false,
  skillsDir = config.skillsDir,
} = {}) {
  let entries
  try {
    const directoryStat = await lstat(directory)
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error('Skills directory must be a real directory.')
    }
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (missingOk && error.code === 'ENOENT') return { skills: [], valid: 0, invalid: 0 }
    throw error
  }
  const skills = []
  let invalid = 0
  for (const entry of entries) {
    if (entry.name === 'users' && skipUsers) continue
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    if (entry.name === 'users') {
      if (includeUserFolders) {
        const usersDirectory = path.join(directory, entry.name)
        let userEntries
        try {
          userEntries = await readdir(usersDirectory, { withFileTypes: true })
        } catch (error) {
          log('error', 'skills.loader.users_scan_failed', {
            path: path.relative(skillsDir, usersDirectory),
            error: { name: error.name, message: error.message },
          })
          continue
        }
        for (const userEntry of userEntries) {
          if (!userEntry.isDirectory() || userEntry.isSymbolicLink()) continue
          try {
            const userSkills = await scanDirectory(path.join(usersDirectory, userEntry.name), { skillsDir })
            skills.push(...userSkills.skills)
            invalid += userSkills.invalid
          } catch (error) {
            invalid += 1
            log('error', 'skills.loader.user_scan_failed', {
              path: path.relative(skillsDir, path.join(usersDirectory, userEntry.name)),
              error: { name: error.name, message: error.message },
            })
          }
        }
      }
      continue
    }
    const folder = path.join(directory, entry.name)
    try {
      const skillFile = path.join(folder, 'SKILL.md')
      const fileStat = await lstat(skillFile)
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > MAX_SKILL_BYTES) {
        throw new Error('SKILL.md must be a regular file within the size limit.')
      }
      const markdown = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(skillFile))
      const parsed = parseSkillMarkdown(markdown)
      if (parsed.name !== entry.name) throw new Error('Skill folder name must match frontmatter name.')
      const supportingFiles = await readSkillSupportingFiles(folder)
      skills.push({
        name: parsed.name,
        description: parsed.description,
        version: parsed.version,
        permissions: parsed.permissions,
        tools: parsed.tools,
        keywords: parsed.keywords,
        creates: parsed.creates,
        body: parsed.body,
        markdown: parsed.markdown,
        dangerous: parsed.dangerous,
        supportingFiles,
        sourcePath: path.relative(skillsDir, skillFile),
      })
    } catch (error) {
      invalid += 1
      log('error', 'skills.loader.invalid_skill', {
        path: path.relative(skillsDir, folder),
        error: { name: error.name, message: error.message },
      })
    }
  }
  return { skills, valid: skills.length, invalid }
}

async function readSkillSupportingFiles(skillDirectory) {
  const result = { scripts: [], references: [], assets: [] }
  let totalBytes = 0
  let fileCount = 0
  async function visit(directory, category, relative = '') {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const childPath = path.join(directory, entry.name)
      const relativePath = path.posix.join(relative, entry.name)
      if (entry.isDirectory()) {
        if (relativePath.split('/').length < 5) await visit(childPath, category, relativePath)
        continue
      }
      if (!entry.isFile()) continue
      fileCount += 1
      if (fileCount > 8) throw new Error('A skill has too many supporting files.')
      const stat = await lstat(childPath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024 ||
        totalBytes + stat.size > 4 * 1024 * 1024) {
        throw new Error('Skill supporting files exceed their size limits.')
      }
      totalBytes += stat.size
      const filePath = `${category}/${relativePath}`
      if (category === 'references') {
        const content = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(childPath))
        result.references.push({
          path: filePath,
          content: content.length > 50_000 ? `${content.slice(0, 50_000)}\n[Reference truncated.]` : content,
        })
      } else if (category === 'assets') {
        const extension = path.extname(entry.name).toLowerCase()
        const asset = { path: filePath, size: stat.size }
        if (TEXT_ASSET_EXTENSIONS.has(extension)) {
          const bytes = await readFile(childPath)
          try {
            const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
            asset.encoding = 'text'
            asset.content = content.length > 50_000 ? `${content.slice(0, 50_000)}\n[Asset truncated.]` : content
          } catch {
            asset.encoding = 'metadata'
          }
        } else if (INLINE_IMAGE_EXTENSIONS.has(extension) && stat.size <= 24 * 1024) {
          asset.encoding = 'base64'
          asset.content = (await readFile(childPath)).toString('base64')
        } else {
          asset.encoding = 'metadata'
        }
        result.assets.push(asset)
      } else {
        result[category].push(filePath)
      }
    }
  }
  for (const category of ['scripts', 'references', 'assets']) {
    const directory = path.join(skillDirectory, category)
    try {
      const stat = await lstat(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue
      await visit(directory, category)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return result
}

function parseScalar(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value)
    } catch (cause) {
      throw new Error('Invalid quoted frontmatter value.', { cause })
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'")
  return value.trim()
}

function tokenize(value) {
  const tokens = String(value || '').toLowerCase().match(/[a-z0-9][a-z0-9+.-]{1,}/g) || []
  return new Set(tokens.map(normalizeToken))
}

function normalizeToken(token) {
  if (token.length > 5 && token.endsWith('ies')) return `${token.slice(0, -3)}y`
  if (token.length > 5 && token.endsWith('ing')) {
    const stem = token.slice(0, -3)
    return stem.length > 2 && stem.at(-1) === stem.at(-2) ? stem.slice(0, -1) : stem
  }
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2)
  if (token.length > 4 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1)
  return token
}

function inferIntent(value) {
  const text = String(value || '').toLowerCase()
  if (/\b(make|create|build|generate|design|draw|animate|produce)\b/.test(text)) return 'create'
  if (/\b(sell|selling|sales|outreach)\b/.test(text)) return 'sell'
  if (/\b(research|look up|find|search|investigate)\b/.test(text)) return 'research'
  if (/\b(analyze|analyse|review|audit|compare)\b/.test(text)) return 'analyze'
  if (/\b(write|draft|compose)\b/.test(text)) return 'write'
  if (/\b(send|email|message)\b/.test(text)) return 'send'
  if (/\b(post|publish)\b/.test(text)) return 'publish'
  return null
}

function normalizeCreationTypes(value, context = '') {
  const requested = Array.isArray(value) ? value.filter((item) => SKILL_CREATION_TYPES.has(item)) : []
  if (requested.length) return [...new Set(requested)]
  const inferred = new Set(['text'])
  if (/\b(file|document|html|download|artifact)\b/i.test(context)) inferred.add('file')
  if (/\b(animation|motion graphics|gif|video|animated)\b/i.test(context)) inferred.add('animation')
  return [...inferred]
}
