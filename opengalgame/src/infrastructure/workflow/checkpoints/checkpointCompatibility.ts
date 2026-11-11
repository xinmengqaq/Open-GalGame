import type { CheckpointMetadata } from '@langchain/langgraph-checkpoint'

import { currentCheckpointCompatibility } from '../CheckpointCompatibility'
import { WorkflowError } from '../WorkflowError'

const SENSITIVE_METADATA_KEYS = new Set([
  'apiKey',
  'api_key',
  'secret',
  'token',
  'authorization',
  'modelConfig',
  'budget',
  'signal',
  'callbacks'
])

export interface SerdePayload {
  type: string
  payload: string
}

export interface CheckpointEnvelope {
  envelopeVersion: number
  langgraph: string
  checkpointLibrary: string
  core: string
  checkpointVersion: number
  checkpointNs: string
  checkpointId: string
  parentCheckpointId?: string
  checkpointSerde: SerdePayload
  metadataSerde: SerdePayload
  inputDigest?: string
  candidateRevision?: string
  externalContentIds?: string[]
  operationId?: string
  revisionRef?: string
}

export interface WriteEnvelope {
  envelopeVersion: number
  langgraph: string
  checkpointLibrary: string
  core: string
  taskId: string
  index: number
  channel: string
  serde: SerdePayload
}

/** 去掉不能进入检查点的密钥和运行时配置字段。保留库恢复所需的元数据。 */
export function checkpointMetadataForStorage(metadata: CheckpointMetadata): CheckpointMetadata {
  const stored: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (SENSITIVE_METADATA_KEYS.has(key)) continue
    stored[key] = value
  }
  return stored as CheckpointMetadata
}

export function encodePayload(type: string, bytes: Uint8Array): SerdePayload {
  return { type, payload: Buffer.from(bytes).toString('base64') }
}

/**
 * @throws {WorkflowError} 载荷不是合法的 base64。
 */
export function decodePayload(payload: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(payload) || payload.length % 4 !== 0) {
    throw new WorkflowError({ category: 'checkpointCorrupt', msg: '检查点已损坏' })
  }
  return new Uint8Array(Buffer.from(payload, 'base64'))
}

/**
 * @throws {WorkflowError} 文件损坏、缺字段或版本不兼容。
 */
export function parseCheckpointEnvelope(value: unknown): CheckpointEnvelope {
  const record = asRecord(value)
  const envelopeVersion = readNumber(record, 'envelopeVersion')
  const langgraph = readString(record, 'langgraph')
  const checkpointLibrary = readString(record, 'checkpointLibrary')
  const core = readString(record, 'core')
  assertRuntimeCompatible({ envelopeVersion, langgraph, checkpointLibrary, core })
  const envelope: CheckpointEnvelope = {
    envelopeVersion,
    langgraph,
    checkpointLibrary,
    core,
    checkpointVersion: readNumber(record, 'checkpointVersion'),
    checkpointNs: readString(record, 'checkpointNs', true),
    checkpointId: readString(record, 'checkpointId'),
    checkpointSerde: readPayload(record, 'checkpointSerde'),
    metadataSerde: readPayload(record, 'metadataSerde')
  }
  const parent = optionalString(record, 'parentCheckpointId')
  const inputDigest = optionalString(record, 'inputDigest')
  const candidateRevision = optionalString(record, 'candidateRevision')
  const operationId = optionalString(record, 'operationId')
  const revisionRef = optionalString(record, 'revisionRef')
  if (parent !== undefined) envelope.parentCheckpointId = parent
  if (inputDigest !== undefined) envelope.inputDigest = inputDigest
  if (candidateRevision !== undefined) envelope.candidateRevision = candidateRevision
  if (operationId !== undefined) envelope.operationId = operationId
  if (revisionRef !== undefined) envelope.revisionRef = revisionRef
  if ('externalContentIds' in record && record.externalContentIds !== undefined) {
    if (!Array.isArray(record.externalContentIds)) {
      throw new WorkflowError({ category: 'checkpointCorrupt', msg: '检查点已损坏' })
    }
    envelope.externalContentIds = record.externalContentIds.map((item) => {
      if (typeof item !== 'string') {
        throw new WorkflowError({ category: 'checkpointCorrupt', msg: '检查点已损坏' })
      }
      return item
    })
  }
  return envelope
}

/**
 * @throws {WorkflowError} 文件损坏或版本不兼容。
 */
export function parseWriteEnvelope(value: unknown): WriteEnvelope {
  const record = asRecord(value)
  const envelopeVersion = readNumber(record, 'envelopeVersion')
  const langgraph = readString(record, 'langgraph')
  const checkpointLibrary = readString(record, 'checkpointLibrary')
  const core = readString(record, 'core')
  assertRuntimeCompatible({ envelopeVersion, langgraph, checkpointLibrary, core })
  const index = record.index
  if (typeof index !== 'number' || !Number.isSafeInteger(index)) {
    throw new WorkflowError({ category: 'checkpointCorrupt', msg: '检查点已损坏' })
  }
  return {
    envelopeVersion,
    langgraph,
    checkpointLibrary,
    core,
    taskId: readString(record, 'taskId'),
    index,
    channel: readString(record, 'channel'),
    serde: readPayload(record, 'serde')
  }
}

/**
 * 版本字段存在但不匹配时拒绝恢复。
 * @throws {WorkflowError} 信封或运行库版本与当前进程不一致。
 */
export function assertRuntimeCompatible(runtime: {
  envelopeVersion: number
  langgraph: string
  checkpointLibrary: string
  core: string
}): void {
  const current = currentCheckpointCompatibility()
  if (
    runtime.envelopeVersion !== current.envelopeVersion ||
    runtime.langgraph !== current.langgraph ||
    runtime.checkpointLibrary !== current.checkpointLibrary ||
    runtime.core !== current.core
  ) {
    throw new WorkflowError({
      category: 'checkpointIncompatible',
      msg: '检查点与当前运行库不兼容'
    })
  }
}

/**
 * @throws {WorkflowError} 值不是对象。
 */
function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkflowError({ category: 'checkpointCorrupt', msg: '检查点已损坏' })
  }
  return value as Record<string, unknown>
}

/**
 * 读取必填字符串。空命名空间允许显式空串。
 * @param allowEmpty - 是否允许空字符串。
 * @throws {WorkflowError} 字段缺失或类型不对。
 */
function readString(record: Record<string, unknown>, field: string, allowEmpty = false): string {
  const value = record[field]
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new WorkflowError({ category: 'checkpointCorrupt', msg: '检查点已损坏' })
  }
  return value
}

/**
 * @throws {WorkflowError} 字段缺失或不是安全整数。
 */
function readNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new WorkflowError({ category: 'checkpointCorrupt', msg: '检查点已损坏' })
  }
  return value
}

/**
 * 读取可选字符串。字段缺失时不补默认值。
 * @returns 字段值；未提供时为 undefined。
 * @throws {WorkflowError} 字段存在但类型不对。
 */
function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  if (!(field in record) || record[field] === undefined) return undefined
  return readString(record, field)
}

/**
 * @throws {WorkflowError} 载荷缺失或类型未知。
 */
function readPayload(record: Record<string, unknown>, field: string): SerdePayload {
  const value = record[field]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkflowError({ category: 'checkpointCorrupt', msg: '检查点已损坏' })
  }
  const payload = value as { type?: unknown; payload?: unknown }
  if (typeof payload.type !== 'string' || payload.type.length === 0) {
    throw new WorkflowError({ category: 'checkpointCorrupt', msg: '检查点已损坏' })
  }
  if (typeof payload.payload !== 'string') {
    throw new WorkflowError({ category: 'checkpointCorrupt', msg: '检查点已损坏' })
  }
  return { type: payload.type, payload: payload.payload }
}
