import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { extractSkillMarkdown, extractSkillUpload } from './archive.js'

test('skill uploads accept a single Markdown file and derive a fallback name', () => {
  const markdown = Buffer.from('---\nname: sample\n---\nbody')
  const result = extractSkillUpload({ originalname: 'My Skill.md', buffer: markdown })
  assert.equal(result.markdown, markdown.toString())
  assert.equal(result.fallbackName, 'My Skill')
  assert.deepEqual(result.ignoredFiles, [])
  assert.equal(result.ignoredFileCount, 0)
})

test('Claude-style ZIPs retain supporting files as inert content', () => {
  const markdown = Buffer.from('---\nname: sample\n---\nbody')
  const archive = makeZip([
    { name: 'claude-skill/SKILL.md', content: markdown },
    { name: 'claude-skill/scripts/setup.py', content: Buffer.from('print("ignored")') },
    { name: 'claude-skill/references/guide.md', content: Buffer.from('ignored reference') },
  ])
  const result = extractSkillUpload({ originalname: 'claude-skill.zip', buffer: archive })
  assert.equal(result.markdown, markdown.toString())
  assert.equal(result.fallbackName, 'claude-skill')
  assert.deepEqual(result.ignoredFiles, [])
  assert.equal(result.ignoredFileCount, 0)
  assert.deepEqual(result.supportingFiles.map(({ path }) => path), ['scripts/setup.py', 'references/guide.md'])
  assert.equal(result.supportingFiles[0].content.toString(), 'print("ignored")')
})

test('ZIP uploads locate SKILL.md nested in multiple folders', () => {
  const markdown = Buffer.from('---\nname: nested\n---\nbody')
  const archive = makeZip([{ name: 'claude-export/skills/nested/SKILL.md', content: markdown }])
  const result = extractSkillUpload({ originalname: 'export.zip', buffer: archive })
  assert.equal(result.markdown, markdown.toString())
  assert.equal(result.fallbackName, 'nested')
})

test('ZIP uploads report missing and ambiguous SKILL.md files clearly', () => {
  const noSkill = makeZip([{ name: 'README.md', content: Buffer.from('no skill') }])
  assert.throws(
    () => extractSkillMarkdown({ originalname: 'missing.zip', buffer: noSkill }),
    /No SKILL\.md found in ZIP/,
  )

  const multiple = makeZip([
    { name: 'one/SKILL.md', content: Buffer.from('first') },
    { name: 'two/SKILL.md', content: Buffer.from('second') },
  ])
  assert.throws(
    () => extractSkillMarkdown({ originalname: 'multiple.zip', buffer: multiple }),
    /multiple SKILL\.md files/,
  )
})

test('skill uploads reject unsupported file types and malformed archives', () => {
  assert.throws(
    () => extractSkillMarkdown({ originalname: 'skill.js', buffer: Buffer.from('code') }),
    /Upload a \.md file or a ZIP/,
  )
  assert.throws(
    () => extractSkillMarkdown({ originalname: 'skill.zip', buffer: Buffer.from('not zip') }),
    /ZIP could not be read/,
  )
})

function makeZip(entries) {
  const localRecords = []
  const centralRecords = []
  let localOffset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const content = Buffer.from(entry.content)
    const compressed = deflateRawSync(content)
    const checksum = crc32(content)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(name.length, 26)
    localRecords.push(local, name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(content.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(localOffset, 42)
    centralRecords.push(central, name)
    localOffset += local.length + name.length + compressed.length
  }
  const centralDirectory = Buffer.concat(centralRecords)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...localRecords, centralDirectory, end])
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
