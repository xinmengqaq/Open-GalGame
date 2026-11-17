'use strict'

const { loadReader } = require('./reader-loader.cjs')
const { sha256 } = require('./manifest.cjs')

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function decodeCanonicalBase64(value) {
  if (typeof value !== 'string') return null
  if (value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null
  const decoded = Buffer.from(value, 'base64')
  const canonical = decoded.toString('base64').replace(/=+$/u, '')
  if (canonical !== value.replace(/=+$/u, '')) return null
  return decoded
}

function operationRollbackReport(value) {
  const present = isObject(value) && Object.hasOwn(value, 'rollbackIndexBytesBase64')
  const raw = present ? value.rollbackIndexBytesBase64 : undefined
  const decoded = typeof raw === 'string' ? decodeCanonicalBase64(raw) : null
  const decodable = decoded !== null
  return {
    source: {
      file: 'src/infrastructure/git/transaction/OperationRecord.ts',
      schema: 'operationRecordSchema',
      field: 'rollbackIndexBytesBase64',
      optional: true,
      type: 'string'
    },
    present,
    decodable: present ? decodable : null,
    decodedBytes: decodable ? decoded.byteLength : null,
    sha256: decodable ? sha256(decoded) : null,
    digest: null,
    digestFieldPresent: false,
    writtenByCurrentTool: false,
    usedByRollback: false,
    classification: 'legacy-optional-unused',
    readImpact: present && !decodable ? 'damaged-record' : 'none'
  }
}

function operationFileResult(result) {
  const raw = isObject(result.raw) ? result.raw : null
  const rollbackIndex = operationRollbackReport(raw)
  const indexDecodable =
    raw !== null && decodeCanonicalBase64(raw.indexBytesBase64) !== null
  return {
    formatVersion: raw !== null && typeof raw.formatVersion === 'number' ? raw.formatVersion : null,
    classification:
      result.kind === 'current' && rollbackIndex.readImpact === 'none' ? 'current' : 'unreadable',
    operationId: raw !== null && typeof raw.operationId === 'string' ? raw.operationId : null,
    phase: raw !== null && typeof raw.phase === 'string' ? raw.phase : null,
    pathsCount: raw !== null && Array.isArray(raw.paths) ? raw.paths.length : null,
    indexDigestPresent: raw !== null && typeof raw.indexDigest === 'string',
    indexDigestValidatedOnRead: false,
    indexDecodable,
    rollbackIndex,
    ...(result.error ? { error: result.error } : {})
  }
}

async function classifyFile(bytes, family, context) {
  let reader
  try {
    reader = await loadReader()
  } catch (error) {
    return {
      classification: 'unreadable',
      formatVersion: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
  if (family === 'operation') {
    const result = await reader.classifyOperationBytes(bytes, context?.operationId ?? '')
    return operationFileResult(result)
  }
  let value
  try {
    value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    )
  } catch (error) {
    return {
      classification: 'unreadable',
      formatVersion: null,
      error: `JSON 或 UTF-8 无效：${error.message}`
    }
  }
  if (family === 'canvas') {
    return reader.classifyCanvas(value, context?.identity ?? {
      projectId: null,
      sceneKey: '',
      canvasKey: ''
    })
  }
  if (family === 'execution') {
    return reader.classifyExecutionEnvelope(value, context?.projectId ?? '')
  }
  return { classification: 'unreadable', formatVersion: null, error: `未知数据族：${family}` }
}

module.exports = {
  classifyFile,
  decodeCanonicalBase64,
  operationRollbackReport,
  operationFileResult
}
