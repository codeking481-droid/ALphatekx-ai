import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getTool } from '../tools/registry.js'
import { getAvailableSkills, parseSkillMarkdown } from '../skills/loader.js'
import { registerLinkedInTools } from './tools.js'

test('LinkedIn skill tools keep publishing and replies approval-gated', async () => {
  const unregister = registerLinkedInTools()
  try {
    assert.equal(getTool('linkedin_post').requiresApproval, true)
    assert.equal(getTool('linkedin_reply').requiresApproval, true)
    assert.equal(getTool('linkedin_read_comments').requiresApproval, false)
    assert.equal(getTool('linkedin_search_people').requiresApproval, false)

    const markdown = await readFile(new URL('../../skills/manage-linkedin/SKILL.md', import.meta.url), 'utf8')
    const skill = parseSkillMarkdown(markdown)
    assert.equal(skill.name, 'manage-linkedin')
    assert.deepEqual(new Set(skill.tools), new Set([
      'linkedin_post',
      'linkedin_read_comments',
      'linkedin_reply',
      'linkedin_search_people',
    ]))
  } finally {
    unregister.forEach((remove) => remove())
  }
})

test('LinkedIn skill is enabled by default but respects an explicit per-user disable', async () => {
  const unregister = registerLinkedInTools()
  const skillsDir = await mkdtemp(path.join(os.tmpdir(), 'alphatekx-linkedin-skill-'))
  try {
    const skillDir = path.join(skillsDir, 'manage-linkedin')
    await mkdir(skillDir)
    await copyFile(
      new URL('../../skills/manage-linkedin/SKILL.md', import.meta.url),
      path.join(skillDir, 'SKILL.md'),
    )
    const database = { query: async () => ({ rows: [] }) }
    let skills = await getAvailableSkills({ userId: 'owner-1', database, skillsDir })
    assert.equal(skills.find(({ name }) => name === 'manage-linkedin').enabled, true)

    skills = await getAvailableSkills({
      userId: 'owner-1',
      database: { query: async () => ({ rows: [{ name: 'manage-linkedin', enabled: false }] }) },
      skillsDir,
    })
    assert.equal(skills.find(({ name }) => name === 'manage-linkedin').enabled, false)
  } finally {
    await rm(skillsDir, { recursive: true, force: true })
    unregister.forEach((remove) => remove())
  }
})
