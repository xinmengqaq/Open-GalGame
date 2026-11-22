import { randomUUID } from 'node:crypto'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
const RESERVED = new Set(['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'lpt1', 'lpt2'])
const POLLUTED = new Set(['__proto__', 'constructor', 'prototype'])
const THREAD_KEY_PREFIX = 'og1.'

export interface WorkflowIdentity {
  projectId: string
  threadId: string
  branchId: string
  operationId: string
  checkpointId?: string
}

export function createWorkflowIdentity(input: WorkflowIdentity): WorkflowIdentity {
  const identity: WorkflowIdentity = {
    projectId: assertWorkflowSegment(input.projectId, 'projectId'),
    threadId: assertWorkflowSegment(input.threadId, 'threadId'),
    branchId: assertWorkflowSegment(input.branchId, 'branchId'),
    operationId: assertWorkflowSegment(input.operationId, 'operationId')
  }
  if (input.checkpointId !== undefined) {
    identity.checkpointId = assertWorkflowSegment(input.checkpointId, 'checkpointId')
  }
  return identity
}

export function assertWorkflowSegment(value: string, label: string): string {
  if (typeof value !== 'string' || !SEGMENT.test(value)) {
    throw invalidIdentity(label)
  }
  const lowered = value.toLowerCase()
  if (RESERVED.has(lowered) || POLLUTED.has(value) || value === '.' || value === '..') {
    throw invalidIdentity(label)
  }
  return value
}

export function langGraphThreadKey(identity: WorkflowIdentity): string {
  const checked = createWorkflowIdentity(identity)
  const payload = Buffer.from(
    JSON.stringify([checked.projectId, checked.threadId, checked.branchId]),
    'utf8'
  ).toString('base64url')
  return `${THREAD_KEY_PREFIX}${payload}`
}

export function scopeFromThreadKey(threadKey: string): {
  projectId: string
  threadId: string
  branchId: string
} {
  if (typeof threadKey !== 'string' || !threadKey.startsWith(THREAD_KEY_PREFIX)) {
    throw invalidIdentity('threadKey')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(
      Buffer.from(threadKey.slice(THREAD_KEY_PREFIX.length), 'base64url').toString('utf8')
    )
  } catch (error) {
    throw new AppException({
      code: ErrorCodes.invalidRequest,
      msg: '工作流身份包含空值或非法路径片段',
      cause: error
    })
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) throw invalidIdentity('threadKey')
  const [projectId, threadId, branchId] = parsed
  if (
    typeof projectId !== 'string' ||
    typeof threadId !== 'string' ||
    typeof branchId !== 'string'
  ) {
    throw invalidIdentity('threadKey')
  }
  return {
    projectId: assertWorkflowSegment(projectId, 'projectId'),
    threadId: assertWorkflowSegment(threadId, 'threadId'),
    branchId: assertWorkflowSegment(branchId, 'branchId')
  }
}

export function assertSameWorkflowScope(
  identity: WorkflowIdentity,
  reference: { projectId: string; threadId: string; branchId: string }
): void {
  const current = createWorkflowIdentity(identity)
  const other = {
    projectId: assertWorkflowSegment(reference.projectId, 'projectId'),
    threadId: assertWorkflowSegment(reference.threadId, 'threadId'),
    branchId: assertWorkflowSegment(reference.branchId, 'branchId')
  }
  if (
    current.projectId !== other.projectId ||
    current.threadId !== other.threadId ||
    current.branchId !== other.branchId
  ) {
    throw new AppException({
      code: ErrorCodes.invalidRequest,
      msg: '检查点引用超出当前作用域'
    })
  }
}

export function createForkIdentity(
  source: WorkflowIdentity,
  checkpointId: string,
  created?: { branchId?: string; operationId?: string }
): WorkflowIdentity {
  const current = createWorkflowIdentity(source)
  return createWorkflowIdentity({
    projectId: current.projectId,
    threadId: current.threadId,
    branchId: created?.branchId ?? randomUUID(),
    operationId: created?.operationId ?? randomUUID(),
    checkpointId
  })
}

function invalidIdentity(label: string): AppException {
  return new AppException({
    code: ErrorCodes.invalidRequest,
    msg: '工作流身份包含空值或非法路径片段',
    cause: label
  })
}
