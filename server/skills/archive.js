import { inflateRawSync } from 'node:zlib'
import { MAX_SKILL_BYTES } from './loader.js'

const ZIP_LIMIT = MAX_SKILL_BYTES * 2

export function extractSkillMarkdown(file) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length > ZIP_LIMIT) {
    throw Object.assign(new Error('Upload must be no larger than 64 KiB.'), { status: 413 })
  }
  const name = String(file.originalname || '').toLowerCase()
  if (name.endsWith('.md')) {
    if (file.buffer.length > MAX_SKILL_BYTES) {
      throw Object.assign(new Error(`SKILL.md must be ${MAX_SKILL_BYTES} bytes or smaller.`), { status: 413 })
    }
    return decodeMarkdown(file.buffer)
  }
  if (!name.endsWith('.zip')) {
    throw Object.assign(new Error('Upload one SKILL.md file or a ZIP containing only SKILL.md.'), { status: 400 })
  }
  return decodeMarkdown(extractSingleSkillEntry(file.buffer))
}

function extractSingleSkillEntry(buffer) {
  const end = findEndRecord(buffer)
  if (end < 0) throw invalidArchive()
  const entries = buffer.readUInt16LE(end + 10)
  const directorySize = buffer.readUInt32LE(end + 12)
  const directoryOffset = buffer.readUInt32LE(end + 16)
  if (entries < 1 || entries > 2 || directoryOffset + directorySize > end) throw invalidArchive()

  let cursor = directoryOffset
  let skillEntry = null
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) throw invalidArchive()
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const checksum = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const externalAttributes = buffer.readUInt32LE(cursor + 38)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength
    if (recordEnd > buffer.length || flags & 1 || compressedSize > ZIP_LIMIT || uncompressedSize > MAX_SKILL_BYTES) {
      throw invalidArchive()
    }
    const entryName = decodeEntryName(buffer.subarray(cursor + 46, cursor + 46 + nameLength))
    const mode = (externalAttributes >>> 16) & 0xffff
    if (mode && (mode & 0o170000) === 0o120000) throw invalidArchive()
    if (entryName.endsWith('/')) {
      if (entries !== 2 || !/^[a-z0-9][a-z0-9-]{0,63}\/$/.test(entryName)) throw invalidArchive()
    } else {
      if (!/^(?:[a-z0-9][a-z0-9-]{0,63}\/)?SKILL\.md$/i.test(entryName) || skillEntry) throw invalidArchive()
      skillEntry = { flags, method, checksum, compressedSize, uncompressedSize, localOffset, entryName }
    }
    cursor = recordEnd
  }
  if (cursor !== directoryOffset + directorySize || !skillEntry || ![0, 8].includes(skillEntry.method)) {
    throw invalidArchive()
  }
  const { localOffset, entryName, method, compressedSize, uncompressedSize, checksum } = skillEntry
  if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw invalidArchive()
  const localFlags = buffer.readUInt16LE(localOffset + 6)
  const localMethod = buffer.readUInt16LE(localOffset + 8)
  const localNameLength = buffer.readUInt16LE(localOffset + 26)
  const localExtraLength = buffer.readUInt16LE(localOffset + 28)
  const localName = decodeEntryName(buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength))
  const dataOffset = localOffset + 30 + localNameLength + localExtraLength
  if (localFlags & 1 || localMethod !== method || localName !== entryName ||
    dataOffset + compressedSize > buffer.length) throw invalidArchive()

  const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize)
  let content
  try {
    content = method === 0
      ? compressed
      : inflateRawSync(compressed, { maxOutputLength: MAX_SKILL_BYTES })
  } catch {
    throw invalidArchive()
  }
  if (content.length !== uncompressedSize || crc32(content) !== checksum) throw invalidArchive()
  return content
}

function findEndRecord(buffer) {
  const minimum = Math.max(0, buffer.length - 22 - 0xffff)
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      const commentLength = buffer.readUInt16LE(offset + 20)
      if (offset + 22 + commentLength === buffer.length) return offset
    }
  }
  return -1
}

function decodeMarkdown(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch (cause) {
    throw Object.assign(new Error('SKILL.md must contain valid UTF-8 text.', { cause }), { status: 400 })
  }
}

function decodeEntryName(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw invalidArchive()
  }
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function invalidArchive() {
  return Object.assign(
    new Error('ZIP must contain exactly one SKILL.md file and optionally its single skill folder; code and other files are not allowed.'),
    { status: 400 },
  )
}
