import { WorkflowError } from '../WorkflowError'

/**
 * 旧生成链路写检查点时的库版本。运行时删除后只保留只读解码，
 * 因此按删除前基线锁定，不再读取已移除的运行时包版本。
 */
export const LEGACY_CHECKPOINT_COMPATIBILITY = {
  envelopeVersion: 1,
  langgraph: '1.4.19',
  checkpointLibrary: '1.1.5',
  core: '1.2.14'
} as const

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

export function decodePayload(payload: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(payload) || payload.length % 4 !== 0) {
    throw new WorkflowError({ category: 'checkpointCorrupt', msg: '检查点已损坏' })
  }
  return new Uint8Array(Buffer.from(payload, 'base64'))
}

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

export function assertRuntimeCompatible(runtime: {
  envelopeVersion: number
  langgraph: string
  checkpointLibrary: string
  core: string
}): void {
  const current = LEGACY_CHECKPOINT_COMPATIBILITY
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

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkflowError({ category: 'checkpointCorrupt', msg: '检查点已损坏' })
  }
  return value as Record<string, unknown>
}

function readString(record: Record<string, unknown>, field: string, allowEmpty = false): string {
  const value = record[field]
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new WorkflowError({ category: 'checkpointCorrupt', msg: '检查点已损坏' })
  }
  return value
}

function readNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new WorkflowError({ category: 'checkpointCorrupt', msg: '检查点已损坏' })
  }
  return value
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  if (!(field in record) || record[field] === undefined) return undefined
  return readString(record, field)
}

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
