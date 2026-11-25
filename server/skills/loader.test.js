import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { registerFileTools } from '../tools/file-tools.js'
import { registerWebSearchTool } from '../tools/web-search.js'
import { registerSkillCreateTool } from './skill-create.js'
import { getSkillAllowedTools, matchSkill, parseSkillMarkdown, scanDirectory } from './loader.js'

registerWebSearchTool()
registerFileTools()
registerSkillCreateTool()

const sampleRoot = new URL('../../skills/', import.meta.url)

test('bundled example and creator skills meet the strict SKILL.md contract', async () => {
  for (const name of ['example-sell-skinsnap', 'example-manage-linkedin', 'create-skill']) {
    const markdown = await readFile(new URL(`${name}/SKILL.md`, sampleRoot), 'utf8')
    const skill = parseSkillMarkdown(markdown)
    assert.equal(skill.name, name)
    assert.ok(skill.body.includes('## What not to do'))
  }
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
