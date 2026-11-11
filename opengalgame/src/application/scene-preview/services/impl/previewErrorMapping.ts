import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ScenePreviewErrorCodes } from '@domain/scene-preview/errors/ScenePreviewErrorCodes'

import type {
  PreviewErrorCode,
  PreviewErrorVO,
  PreviewRecoveryAction
} from '../../vo/PreviewErrorVO'

export const previewErrorMessages: Record<PreviewErrorCode, string> = {
  invalidRequest: '预览请求无效',
  sceneUnavailable: '当前场景不可用',
  sceneArtifactMissing: '当前场景还没有可预览的内容',
  contentUnreadable: '当前场景内容无法读取',
  sessionNotFound: '预览会话不存在',
  sessionClosed: '预览会话已关闭',
  prepareAlreadyDone: '舞台已经准备完成',
  prepareFailed: '舞台准备失败',
  runtimeNotPrepared: '舞台尚未准备',
  runtimeNotReady: '舞台尚未就绪',
  runtimeDisconnected: '舞台连接已断开',
  commandTimeout: '舞台没有及时确认',
  staleRuntimeGeneration: '舞台已经更换，请使用当前舞台',
  branchChoiceRequired: '需要先选择分支',
  locateNotReached: '目标台词没有到达',
  positionCaptureFailed: '未能确认当前播放位置',
  restoreFailed: '预览没有回到原来的位置',
  restoreTargetMissing: '没有可恢复的播放位置',
  restorePositionMismatch: '恢复后的位置与保存前不一致',
  playbackCompleted: '本场已经播放结束',
  contentBasisChanged: '场景内容已经变化，请重新打开',
  contentLocked: '当前场景已锁定，不能修改',
  dialogueObjectInvalid: '要修改的台词已失效',
  saveRequestReused: '同一次保存不能改用不同内容',
  saveOutcomeUnknown: '保存结果尚未核对',
  saveNotConfirmed: '这次保存尚未确认',
  saveSettlementConflict: '保存记录与当前场景不一致',
  previewUpdatePending: '保存后的预览尚未恢复',
  engineCapabilityUnavailable: '当前舞台不能暂停、继续、捕获或恢复'
}

export const previewErrorRecovery: Record<PreviewErrorCode, PreviewRecoveryAction> = {
  invalidRequest: 'none',
  sceneUnavailable: 'reopen',
  sceneArtifactMissing: 'none',
  contentUnreadable: 'reopen',
  sessionNotFound: 'reopen',
  sessionClosed: 'reopen',
  prepareAlreadyDone: 'none',
  prepareFailed: 'prepare',
  runtimeNotPrepared: 'prepare',
  runtimeNotReady: 'retry',
  runtimeDisconnected: 'prepare',
  commandTimeout: 'retry',
  staleRuntimeGeneration: 'none',
  branchChoiceRequired: 'none',
  locateNotReached: 'retry',
  positionCaptureFailed: 'retry',
  restoreFailed: 'retryPreviewUpdate',
  restoreTargetMissing: 'none',
  restorePositionMismatch: 'retryPreviewUpdate',
  playbackCompleted: 'replay',
  contentBasisChanged: 'reopen',
  contentLocked: 'none',
  dialogueObjectInvalid: 'reopen',
  saveRequestReused: 'none',
  saveOutcomeUnknown: 'querySettlement',
  saveNotConfirmed: 'querySettlement',
  saveSettlementConflict: 'querySettlement',
  previewUpdatePending: 'retryPreviewUpdate',
  engineCapabilityUnavailable: 'none'
}

const domainRejectionCodes: Partial<Record<number, PreviewErrorCode>> = {
  [ScenePreviewErrorCodes.duplicateEditDialogueId]: 'dialogueObjectInvalid',
  [ScenePreviewErrorCodes.dialogueTargetMissing]: 'dialogueObjectInvalid',
  [ScenePreviewErrorCodes.dialogueNotEditable]: 'contentLocked',
  [ScenePreviewErrorCodes.invalidDialogueText]: 'dialogueObjectInvalid',
  [ScenePreviewErrorCodes.blankDialogueText]: 'dialogueObjectInvalid',
  [ScenePreviewErrorCodes.blankDialogueId]: 'dialogueObjectInvalid',
  [ScenePreviewErrorCodes.emptyEditSet]: 'invalidRequest',
  [ScenePreviewErrorCodes.invalidSceneIdentity]: 'sceneUnavailable',
  [ScenePreviewErrorCodes.duplicateDialogueId]: 'contentUnreadable',
  [ScenePreviewErrorCodes.invalidSnapshotEntry]: 'contentUnreadable'
}

export function previewError(code: PreviewErrorCode, dialogueId?: string): PreviewErrorVO {
  return {
    code,
    message: previewErrorMessages[code],
    recovery: previewErrorRecovery[code],
    ...(dialogueId === undefined ? {} : { dialogueId })
  }
}

export function previewFailure(code: PreviewErrorCode): AppException {
  return new AppException({
    code: ErrorCodes.invalidRequest,
    msg: previewErrorMessages[code],
    cause: code
  })
}

export function isPreviewFailure(error: unknown, code: PreviewErrorCode): boolean {
  return error instanceof AppException && error.cause === code
}

export function rejectionFromDomain(error: unknown): PreviewErrorVO | undefined {
  if (!(error instanceof AppException)) return undefined
  const code = domainRejectionCodes[error.code]
  return code === undefined ? undefined : previewError(code)
}

export function openFailureCode(error: unknown): PreviewErrorCode {
  if (error instanceof AppException && error.code === ErrorCodes.forbidden)
    return 'sceneUnavailable'
  if (error instanceof AppException && error.code === ErrorCodes.invalidRequest) {
    return 'sceneUnavailable'
  }
  return 'contentUnreadable'
}
