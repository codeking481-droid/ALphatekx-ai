import { inflateRawSync } from 'node:zlib'
import { MAX_SKILL_BYTES } from './loader.js'

export const MAX_SKILL_UPLOAD_BYTES = 8 * 1024 * 1024
const MAX_ZIP_ENTRIES = 1024

export function extractSkillUpload(file) {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw Object.assign(new Error('Choose a SKILL.md file or a ZIP containing SKILL.md.'), { status: 400 })
  }
  if (file.buffer.length > MAX_SKILL_UPLOAD_BYTES) {
    throw Object.assign(new Error('Skill uploads must be 8 MiB or smaller.'), { status: 413 })
  }

  const name = String(file.originalname || '').toLowerCase()
  if (name.endsWith('.md')) {
    if (file.buffer.length > MAX_SKILL_BYTES) {
      throw Object.assign(new Error(`SKILL.md must be ${MAX_SKILL_BYTES} bytes or smaller.`), { status: 413 })
    }
    return {
      markdown: decodeMarkdown(file.buffer),
      fallbackName: pathBase(file.originalname).replace(/\.md$/i, ''),
      ignoredFiles: [],
      ignoredFileCount: 0,
    }
  }
  if (!name.endsWith('.zip')) {
    throw Object.assign(new Error('Upload a .md file or a ZIP containing SKILL.md.'), { status: 400 })
  }
  const extracted = extractSkillEntry(file.buffer)
  return {
    markdown: decodeMarkdown(extracted.content),
    fallbackName: extracted.fallbackName || pathBase(file.originalname).replace(/\.zip$/i, ''),
    ignoredFiles: extracted.ignoredFiles,
    ignoredFileCount: extracted.ignoredFileCount,
  }
}

export function extractSkillMarkdown(file) {
  return extractSkillUpload(file).markdown
}

function extractSkillEntry(buffer) {
  const end = findEndRecord(buffer)
  if (end < 0) throw invalidArchive()
  const diskNumber = buffer.readUInt16LE(end + 4)
  const directoryDisk = buffer.readUInt16LE(end + 6)
  const diskEntries = buffer.readUInt16LE(end + 8)
  const entries = buffer.readUInt16LE(end + 10)
  const directorySize = buffer.readUInt32LE(end + 12)
  const directoryOffset = buffer.readUInt32LE(end + 16)
  if (diskNumber !== 0 || directoryDisk !== 0 || diskEntries !== entries ||
    entries < 1 || entries > MAX_ZIP_ENTRIES ||
    directoryOffset + directorySize !== end) throw invalidArchive()

  let cursor = directoryOffset
  const skillEntries = []
  const ignoredFiles = []
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
    if (recordEnd > buffer.length || (flags & 1) !== 0 || !nameLength || nameLength > 1024) throw invalidArchive()
    const entryName = decodeEntryName(buffer.subarray(cursor + 46, cursor + 46 + nameLength))
    if (entryName.includes('\0')) throw invalidArchive()
    if (entryName.endsWith('/')) {
      cursor = recordEnd
      continue
    }
    if (pathBase(entryName).toLowerCase() === 'skill.md') {
      if (entryName.startsWith('/') || entryName.includes('\\') ||
        entryName.split('/').some((part) => part === '..' || part === '.')) {
        throw invalidArchive()
      }
      const mode = (externalAttributes >>> 16) & 0xffff
      if (mode && (mode & 0o170000) === 0o120000) throw invalidArchive()
      skillEntries.push({
        flags,
        method,
        checksum,
        compressedSize,
        uncompressedSize,
        localOffset,
        entryName,
        fallbackName: entryName.includes('/')
          ? entryName.split('/').filter(Boolean).slice(-2, -1)[0]
          : '',
      })
    } else {
      ignoredFiles.push(entryName)
    }
    cursor = recordEnd
  }
  if (cursor !== directoryOffset + directorySize) throw invalidArchive()
  if (skillEntries.length === 0) {
    throw Object.assign(
      new Error('No SKILL.md found in ZIP. ZIP must contain SKILL.md at its root or inside a folder.'),
      { status: 400 },
    )
  }
  if (skillEntries.length > 1) {
    throw Object.assign(new Error('ZIP contains multiple SKILL.md files. Keep only the skill you want to install.'), { status: 400 })
  }
  const skillEntry = skillEntries[0]
  if (skillEntry.uncompressedSize > MAX_SKILL_BYTES || ![0, 8].includes(skillEntry.method)) {
    throw Object.assign(new Error(`SKILL.md must be ${MAX_SKILL_BYTES} bytes or smaller and use standard ZIP compression.`), { status: 400 })
  }
  const { localOffset, entryName, method, compressedSize, uncompressedSize, checksum } = skillEntry
  if (localOffset + 30 > directoryOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw invalidArchive()
  const localFlags = buffer.readUInt16LE(localOffset + 6)
  const localMethod = buffer.readUInt16LE(localOffset + 8)
  const localNameLength = buffer.readUInt16LE(localOffset + 26)
  const localExtraLength = buffer.readUInt16LE(localOffset + 28)
  const localName = decodeEntryName(buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength))
  const dataOffset = localOffset + 30 + localNameLength + localExtraLength
  if ((localFlags & 1) !== 0 || localMethod !== method || localName !== entryName ||
    dataOffset + compressedSize > directoryOffset) throw invalidArchive()

  const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize)
  let content
  try {
    content = method === 0
      ? compressed
      : inflateRawSync(compressed, { maxOutputLength: MAX_SKILL_BYTES })
  } catch {
    throw Object.assign(new Error('SKILL.md could not be decompressed from the ZIP.'), { status: 400 })
  }
  if (content.length !== uncompressedSize || crc32(content) !== checksum) throw invalidArchive()
  return {
    content,
    fallbackName: skillEntry.fallbackName,
    ignoredFiles: ignoredFiles.slice(0, 20),
    ignoredFileCount: ignoredFiles.length,
  }
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

function pathBase(value) {
  return String(value || '').split(/[\\/]/).filter(Boolean).at(-1) || ''
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
    new Error('ZIP could not be read. Upload a valid ZIP containing one SKILL.md file.'),
    { status: 400 },
  )
}
