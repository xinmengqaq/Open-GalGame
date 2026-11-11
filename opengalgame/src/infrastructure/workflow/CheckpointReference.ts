import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

import {
  assertSameWorkflowScope,
  assertWorkflowSegment,
  type WorkflowIdentity
} from './WorkflowIdentity'

export interface CheckpointReference {
  projectId: string
  threadId: string
  branchId: string
  checkpointId: string
  parentCheckpointId?: string
  inputDigest?: string
  candidateRevision?: string
  externalContentIds?: readonly string[]
}

/**
 * 建立属于当前身份的检查点引用。不复制工程，也不访问 Git。
 * @param fields - 父检查点、输入摘要、候选修订和外置内容引用。
 * @throws {AppException} 标识非法，或引用超出当前作用域。
 */
export function createCheckpointReference(
  identity: WorkflowIdentity,
  checkpointId: string,
  fields?: {
    parentCheckpointId?: string
    inputDigest?: string
    candidateRevision?: string
    externalContentIds?: readonly string[]
  }
): CheckpointReference {
  const reference: CheckpointReference = {
    projectId: identity.projectId,
    threadId: identity.threadId,
    branchId: identity.branchId,
    checkpointId: assertWorkflowSegment(checkpointId, 'checkpointId')
  }
  if (fields?.parentCheckpointId !== undefined) {
    reference.parentCheckpointId = assertWorkflowSegment(
      fields.parentCheckpointId,
      'parentCheckpointId'
    )
  }
  if (fields?.inputDigest !== undefined) {
    reference.inputDigest = assertDigest(fields.inputDigest)
  }
  if (fields?.candidateRevision !== undefined) {
    reference.candidateRevision = assertRevisionToken(fields.candidateRevision)
  }
  if (fields?.externalContentIds !== undefined) {
    reference.externalContentIds = fields.externalContentIds.map((id) =>
      assertWorkflowSegment(id, 'externalContentId')
    )
  }
  assertSameWorkflowScope(identity, reference)
  return reference
}

/**
 * 拒绝跨项目、线程或分支的检查点引用。
 * @throws {AppException} 引用不在当前作用域内。
 */
export function assertCheckpointInScope(
  identity: WorkflowIdentity,
  reference: CheckpointReference
): void {
  assertSameWorkflowScope(identity, reference)
  assertWorkflowSegment(reference.checkpointId, 'checkpointId')
}

/**
 * 校验不可变输入摘要。
 * @throws {AppException} 摘要为空或含路径分隔符。
 */
function assertDigest(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    /[\\/\0]/u.test(value)
  ) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '输入摘要无效' })
  }
  return value
}

/**
 * 校验候选修订引用。只接受对象标识，不读取 Git。
 * @throws {AppException} 修订不是安全的对象标识。
 */
export function assertRevisionToken(value: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{7,64}$/u.test(value)) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '候选修订引用无效' })
  }
  return value
}
