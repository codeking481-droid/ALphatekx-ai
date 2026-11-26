import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { registerFileTools } from '../tools/file-tools.js'
import { registerWebSearchTool } from '../tools/web-search.js'
import { registerSkillCreateTool } from './skill-create.js'
import { registerMotionGraphicsTool } from '../tools/motion-graphics.js'
import {
  getSkillAllowedTools,
  matchSkill,
  normalizeSkillUpload,
  parseSkillMarkdown,
  scanDirectory,
} from './loader.js'

registerWebSearchTool()
registerFileTools()
registerSkillCreateTool()
registerMotionGraphicsTool()

const sampleRoot = new URL('../../skills/', import.meta.url)

test('bundled example and creator skills meet the strict SKILL.md contract', async () => {
  for (const name of ['example-sell-skinsnap', 'example-manage-linkedin', 'create-skill', 'motion-graphics']) {
    const markdown = await readFile(new URL(`${name}/SKILL.md`, sampleRoot), 'utf8')
    const skill = parseSkillMarkdown(markdown)
    assert.equal(skill.name, name)
    assert.ok(skill.body.includes('## What not to do'))
  }
})

test('motion graphics skill declares animation output without executable scripts', async () => {
  const markdown = await readFile(new URL('motion-graphics/SKILL.md', sampleRoot), 'utf8')
  const skill = parseSkillMarkdown(markdown)
  assert.deepEqual(skill.creates, ['file', 'animation'])
  assert.deepEqual(skill.tools, ['motion_graphics_create'])
  assert.match(skill.body, /never execute uploaded or generated scripts/i)
})

test('skill matching chooses the strongest enabled description match and ignores disabled skills', () => {
  const skills = [
    { name: 'example-sell-skinsnap', description: 'Research and draft outreach for selling SkinSnap to UK businesses.', enabled: true },
    { name: 'example-manage-linkedin', description: 'Plan LinkedIn posts and improve profiles.', enabled: true },
  ]
  assert.equal(matchSkill('Sell SkinSnap to UK companies', skills)?.name, 'example-sell-skinsnap')
  assert.equal(matchSkill('Create hello.html', skills), null)
  assert.equal(matchSkill('Sell SkinSnap to UK companies', skills.map((skill) => ({ ...skill, enabled: false }))), null)
})

test('active LinkedIn skill stays selected for date and schedule follow-ups', () => {
  const skills = [
    { name: 'manage-linkedin', description: 'Manage LinkedIn posts and schedules.', enabled: true },
    { name: 'motion-graphics', description: 'Create motion graphics and animated text.', enabled: true },
  ]
  const activeSkill = { name: 'manage-linkedin', version: '1.0.0' }

  for (const message of [
    'Fix dates to Fri Nov 27 through Thu Dec 3, same 7 texts.',
    'Start tomorrow, not today; 10am already passed.',
  ]) {
    assert.equal(
      matchSkill(message, skills, { activeSkill, preserveActiveSkill: true })?.name,
      'manage-linkedin',
    )
  }
})

test('skill matching uses keywords and intent to choose the right birthday-card skill', () => {
  const skills = [
    {
      name: 'party-invitation',
      description: 'Design invitations for celebrations.',
      keywords: ['party', 'invitation'],
      enabled: true,
    },
    {
      name: 'birthday-card',
      description: 'Create a personalized birthday card as HTML.',
      keywords: ['birthday', 'greeting card', 'balloons'],
      body: 'Make a colorful card with the recipient name and celebratory animation.',
      enabled: true,
    },
  ]
  assert.equal(
    matchSkill('Make a birthday card for Precious, pink, with balloons', skills)?.name,
    'birthday-card',
  )
  assert.equal(matchSkill('What is the weather in London?', skills), null)
})

test('a skill can only declare available tools and no-skill fallback excludes skill management tools', () => {
  const markdown = `---
name: invalid-shell
description: This skill asks for a tool that AlphaTekx does not expose.
version: 1.0.0
permissions:
  - tool:approved
tools:
  - shell
---
## When to use

Only for a test.

## Steps

Do nothing.

## Examples

None.

## What not to do

Nothing.
`
  assert.throws(() => parseSkillMarkdown(markdown), /unavailable tool/)
  assert.deepEqual(new Set(getSkillAllowedTools(null, true)), new Set(['web_search', 'file_read', 'file_list', 'file_write']))
})

test('Claude-style frontmatter and optional metadata normalize into a usable Biz skill', () => {
  const markdown = `---
name: Claude Research
description: >-
  Research a topic and summarize relevant sources.
compatibility: Claude Desktop
metadata:
  author: Claude
  category: research
allowed-tools: Read
---
# Research carefully

Use the provided instructions to answer research questions.
`
  const normalized = normalizeSkillUpload(markdown, 'research-export')
  const skill = parseSkillMarkdown(normalized)
  assert.equal(skill.name, 'claude-research')
  assert.equal(skill.description, 'Research a topic and summarize relevant sources.')
  assert.equal(skill.version, '1.0.0')
  assert.deepEqual(new Set(skill.tools), new Set(['web_search', 'file_read', 'file_list']))
  assert.equal(skill.body.startsWith('# Research carefully'), true)
})

test('uploaded keywords are retained and relevant file-creation tools are suggested', () => {
  const markdown = `---
name: birthday-card
description: Make a personalized birthday card as HTML.
keywords:
  - birthday
  - greeting card
---
Create a fresh birthday card for the recipient.
`
  const skill = parseSkillMarkdown(normalizeSkillUpload(markdown, 'birthday-card'))
  assert.deepEqual(skill.keywords, ['birthday', 'greeting card'])
  assert.ok(skill.tools.includes('motion_graphics_create'))
})

test('missing or malformed upload frontmatter gets filename and first-line defaults', () => {
  const malformed = `---
name missing-colon
---
# A helpful first-line summary

The skill instructions do not need Biz-specific headings.
`
  const normalized = normalizeSkillUpload(malformed, 'Claude Export')
  const skill = parseSkillMarkdown(normalized)
  assert.equal(skill.name, 'claude-export')
  assert.equal(skill.description, 'A helpful first-line summary')
  assert.equal(skill.version, '1.0.0')
  assert.equal(skill.body.includes('do not need Biz-specific headings'), true)
})

test('uploads preserve registered protected tools but never grant their permissions', () => {
  const markdown = `---
name: protected-writer
description: Draft and write a requested workspace file.
tools:
  - file_write
---
Write only after the user asks.
`
  const skill = parseSkillMarkdown(normalizeSkillUpload(markdown, 'writer'))
  assert.deepEqual(skill.tools, ['file_write'])
  assert.deepEqual(skill.permissions, ['tool:approved'])
  assert.equal(skill.dangerous, true)
})

test('startup scanning skips an invalid skill and retains valid skills', async () => {
  const skillsDir = await mkdtemp(path.join(os.tmpdir(), 'alphatekx-skills-loader-'))
  try {
    const valid = await readFile(new URL('example-sell-skinsnap/SKILL.md', sampleRoot), 'utf8')
    await mkdir(path.join(skillsDir, 'valid-skill'))
    await writeFile(path.join(skillsDir, 'valid-skill', 'SKILL.md'), valid.replace('example-sell-skinsnap', 'valid-skill'))
    await mkdir(path.join(skillsDir, 'broken-skill'))
    await writeFile(path.join(skillsDir, 'broken-skill', 'SKILL.md'), '---\nname: broken-skill\n---\ninvalid')

    const result = await scanDirectory(skillsDir, { skillsDir })
    assert.equal(result.valid, 1)
    assert.equal(result.invalid, 1)
    assert.deepEqual(result.skills.map(({ name }) => name), ['valid-skill'])
  } finally {
    await rm(skillsDir, { recursive: true, force: true })
  }
})
