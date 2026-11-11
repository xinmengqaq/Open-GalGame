import type { DialogueTextEditDTO } from '@application/scene-preview/dto/DialogueSaveDTO'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type {
  DialogueSaveSettlementVO,
  PreviewUpdateVO
} from '@application/scene-preview/vo/DialogueSaveVO'
import type {
  PreviewErrorCode,
  PreviewErrorVO,
  PreviewRecoveryAction
} from '@application/scene-preview/vo/PreviewErrorVO'
import type {
  PreviewDraftUnavailableReason,
  PreviewPhase,
  PreviewPositionVO
} from '@application/scene-preview/vo/PreviewRuntimeVO'
import type {
  SceneDialogueVO,
  ScenePreviewIssueCode,
  ScenePreviewIssueVO,
  ScenePreviewLockState
} from '@application/scene-preview/vo/ScenePreviewSessionVO'

export type PreviewFailureView = {
  readonly code: PreviewErrorCode | null
  readonly message: string
  readonly recovery: PreviewRecoveryAction
  readonly dialogueId?: string
}

export type PreviewStatusTone = 'ok' | 'dirty' | 'busy' | 'warning' | 'error' | 'muted'

export type PreviewStageTone = 'ok' | 'busy' | 'quiet' | 'error'

export type PreviewSaveUiState =
  | { readonly status: 'idle' }
  | { readonly status: 'saving' }
  | { readonly status: 'saved' }
  | { readonly status: 'unchanged' }
  | { readonly status: 'rejected'; readonly failure: PreviewFailureView }
  | {
      readonly status: 'pending'
      readonly requestId: string
      readonly failure: PreviewFailureView
      readonly querying: boolean
      readonly queryNote: string | null
    }

export type PreviewNoticeAction = 'retryLocate' | 'reopen' | 'none'

export const previewCopy = {
  stageTitle: '实时预览',
  stageKicker: '真实舞台',
  saveSucceeded: '已保存',
  saveUnchanged: '内容没有变化',
  saving: '保存中…',
  pending: '等待确认',
  rejected: '保存失败',
  locked: '只读',
  syncing: '已保存 · 预览未同步'
} as const

const previewFailureMessages: Record<PreviewErrorCode, string> = {
  invalidRequest: '这次操作没有完成，请重试。',
  sceneUnavailable: '这个场景暂时打不开。返回工作台后再试。',
  sceneArtifactMissing: '这个场景还没有可预览的内容。先在场景画布生成并保存一次。',
  contentUnreadable: '这个场景暂时打不开。返回工作台后再试。',
  sessionNotFound: '预览已经结束，请重新打开。',
  sessionClosed: '预览已经关闭，请重新打开。',
  prepareAlreadyDone: '舞台已经准备好，重新打开预览可以继续。',
  prepareFailed: '舞台没有加载成功。左侧台词仍然可以修改和保存。',
  runtimeNotPrepared: '舞台还没有准备，需要重新打开预览。',
  runtimeNotReady: '舞台还没有连接上，可以稍后重试定位。',
  runtimeDisconnected: '舞台连接断开了，需要重新打开预览。',
  commandTimeout: '舞台没有及时回应，可以重试定位。',
  staleRuntimeGeneration: '舞台画面已经更换，需要重新定位。',
  branchChoiceRequired: '目标台词在分支选项之后，暂时不能直接跳过去。',
  locateNotReached: '没有到达目标台词，可以重试定位。',
  positionCaptureFailed: '没有确认当前播放位置。',
  restoreFailed: '预览没有回到目标台词。',
  restoreTargetMissing: '没有可以恢复的台词位置。',
  restorePositionMismatch: '预览没有停在目标台词。',
  playbackCompleted: '本场已经播完，可以重播。',
  contentBasisChanged: '场景内容已经在别处变化，需要重新打开预览。',
  contentLocked: '这个场景正在别处编辑，现在只能查看。',
  dialogueObjectInvalid: '这一句已经不能修改，请重新打开预览。',
  saveRequestReused: '这次保存没有完成，请重新保存。',
  saveOutcomeUnknown: '保存结果还没有确认，请查看结果。',
  saveNotConfirmed: '没有找到这次保存记录，内容仍保留在左侧。',
  saveSettlementConflict: '保存记录与当前场景不一致，需要重新打开预览。',
  previewUpdatePending: '保存已经完成，预览还没有回到目标台词。',
  engineCapabilityUnavailable: '当前引擎版本不支持试玩预览或台词定位。'
}

const issueCopy: Record<
  ScenePreviewIssueCode,
  { readonly label: string; readonly message: string }
> = {
  missingStableId: {
    label: '有一句无法定位',
    message: '这一句缺少定位信息，预览可能停不到这里。'
  },
  duplicateStableId: {
    label: '有两句位置重复',
    message: '相邻台词的位置重复，预览可能停在错误的句子上。'
  },
  unresolvedStep: {
    label: '有一段演出看不懂',
    message: '有一段演出的步骤无法识别，播放时可能会被跳过。'
  },
  unsupportedStatement: {
    label: '有一段演出无法预览',
    message: '有一段演出暂不支持，播放时可能会被跳过。'
  },
  unsupportedParameter: {
    label: '有一段演出效果不完整',
    message: '有一段演出的效果无法完整显示，画面可能和保存的内容不一致。'
  },
  missingAsset: {
    label: '缺少素材',
    message: '有素材没有找到，这一段可能显示不完整。'
  },
  invalidAssetReference: {
    label: '素材无法读取',
    message: '有人物或背景素材无法读取，画面上可能缺失。'
  },
  lockMetadataMissing: {
    label: '编辑状态未确认',
    message: '暂时读不到这个场景的编辑状态；修改前请重新打开预览。'
  }
}

export const draftUnavailableLabels: Record<PreviewDraftUnavailableReason, string> = {
  runtimeNotPrepared: '舞台尚未准备，草稿只保留在左侧。',
  runtimeNotReady: '舞台还没有连接，草稿暂时无法显示。',
  staleRuntimeGeneration: '舞台已经更换，草稿没有送到当前舞台。',
  dialogueNotMounted: '这句台词暂时无法在舞台上定位。'
}

export function failureFromError(error: PreviewErrorVO): PreviewFailureView {
  return {
    code: error.code,
    message: previewFailureMessages[error.code],
    recovery: error.recovery,
    ...(error.dialogueId === undefined ? {} : { dialogueId: error.dialogueId })
  }
}

export function previewIssueList(issues: readonly ScenePreviewIssueVO[]): readonly {
  readonly key: string
  readonly label: string
  readonly message: string
  readonly dialogueId?: string
}[] {
  const seen = new Map<string, number>()
  return issues.map((issue) => {
    const index = seen.get(issue.code) ?? 0
    seen.set(issue.code, index + 1)
    const copy = issueCopy[issue.code]
    return {
      key: `${issue.code}-${index}`,
      label: copy.label,
      message: copy.message,
      ...(issue.dialogueId === undefined ? {} : { dialogueId: issue.dialogueId })
    }
  })
}

export function dialogueNumber(
  dialogues: readonly SceneDialogueVO[],
  dialogueId: string
): number | null {
  const index = dialogues.findIndex((dialogue) => dialogue.dialogueId === dialogueId)
  return index < 0 ? null : index + 1
}

export function positionTextOf(
  position: PreviewPositionVO,
  dialogues: readonly SceneDialogueVO[]
): string {
  if (position.kind === 'dialogue') {
    const number = dialogueNumber(dialogues, position.dialogueId)
    return number === null ? '位置已确认' : `第 ${number} 句 / 共 ${dialogues.length} 句`
  }
  if (position.kind === 'nonDialogue') return '演出中'
  if (position.kind === 'completed') return `共 ${dialogues.length} 句`
  return '位置待确认'
}

/**
 * 舞台状态以真实句位为准。引擎快照没有播放阶段时，已定位的台词仍是可核对事实；
 * 没有句位时只说明正在进入，不伪造播放、暂停或就绪。
 */
export function phaseStatusOf(options: {
  readonly stage: 'preparing' | 'ready' | 'failed'
  readonly phase: PreviewPhase
  readonly position: PreviewPositionVO
}): { readonly label: string; readonly tone: PreviewStageTone } {
  const { stage, phase, position } = options
  if (stage === 'failed') return { label: '无法试玩', tone: 'error' }
  if (stage === 'preparing' || phase === 'preparing') return { label: '准备中', tone: 'busy' }
  if (phase === 'playing') return { label: '播放中', tone: 'ok' }
  if (phase === 'paused') return { label: '已暂停', tone: 'quiet' }
  if (phase === 'completed') return { label: '本场结束', tone: 'quiet' }
  if (position.kind === 'dialogue') return { label: '已定位', tone: 'ok' }
  if (position.kind === 'nonDialogue') return { label: '演出中', tone: 'ok' }
  if (position.kind === 'completed') return { label: '本场结束', tone: 'quiet' }
  return { label: '正在进入', tone: 'busy' }
}

export function saveStatusOf(options: {
  readonly state: PreviewSaveUiState
  readonly dirtyCount: number
  readonly lockState: ScenePreviewLockState
  readonly previewSyncLost: boolean
}): { readonly label: string; readonly tone: PreviewStatusTone } {
  const { state, dirtyCount, lockState, previewSyncLost } = options
  if (lockState !== 'editable') return { label: previewCopy.locked, tone: 'muted' }
  if (state.status === 'saving') return { label: previewCopy.saving, tone: 'busy' }
  if (state.status === 'pending') return { label: previewCopy.pending, tone: 'busy' }
  if (state.status === 'rejected') return { label: previewCopy.rejected, tone: 'error' }
  if (dirtyCount > 0) return { label: `${dirtyCount} 处未保存`, tone: 'dirty' }
  if (state.status === 'unchanged') return { label: previewCopy.saveUnchanged, tone: 'ok' }
  if (state.status === 'saved' && previewSyncLost) {
    return { label: previewCopy.syncing, tone: 'warning' }
  }
  return { label: previewCopy.saveSucceeded, tone: 'ok' }
}

export function saveHintOf(options: {
  readonly state: PreviewSaveUiState
  readonly dirtyCount: number
  readonly blankCount: number
  readonly lockState: ScenePreviewLockState
  readonly blockedReason: string | null
  readonly sessionOpen: boolean
}): string | null {
  const { state, dirtyCount, blankCount, lockState, blockedReason, sessionOpen } = options
  if (!sessionOpen) return '预览还没有打开。'
  if (lockState === 'locked') return '这个场景正在别处编辑，当前只能查看。'
  if (lockState === 'unknown') return '无法确认场景是否可编辑，已按只读处理。'
  if (blockedReason !== null) return blockedReason
  if (state.status === 'saving') return '保存完成前请稍候。'
  if (state.status === 'pending') return '保存结果还在确认，先不要再次保存。'
  if (blankCount > 0) return `有 ${blankCount} 处台词还没有文字，补上后再保存。`
  if (dirtyCount === 0) return '没有需要保存的修改。'
  return null
}

export function historyHint(options: {
  readonly action: 'undo' | 'redo'
  readonly available: boolean
  readonly editing: boolean
  readonly lockState: ScenePreviewLockState
  readonly saveState: PreviewSaveUiState
}): string {
  const name = options.action === 'undo' ? '撤销' : '重做'
  const shortcut = options.action === 'undo' ? 'Ctrl+Z' : 'Ctrl+Shift+Z'
  if (options.available) return `${name}（${shortcut}）`
  if (options.lockState !== 'editable') return '当前场景只读'
  if (options.editing) return `结束本次编辑后可${name}`
  if (options.saveState.status === 'saving') return `保存期间不能${name}`
  if (options.saveState.status === 'pending') return `保存结果确认前不能${name}`
  return options.action === 'undo' ? '没有可撤销的修改' : '没有可重做的修改'
}

export function mergeCommittedEdits(
  baseline: Readonly<Record<string, string>>,
  edits: readonly DialogueTextEditDTO[]
): Record<string, string> {
  const next = { ...baseline }
  for (const edit of edits) next[edit.dialogueId] = edit.text
  return next
}

export function normalizeDrafts(
  drafts: Readonly<Record<string, string>>,
  baseline: Readonly<Record<string, string>>
): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [dialogueId, text] of Object.entries(drafts)) {
    if (baseline[dialogueId] !== text) next[dialogueId] = text
  }
  return next
}

export function previewUpdateCopy(
  update: PreviewUpdateVO,
  targetNumber: number | null
): {
  readonly tone: 'ok' | 'warning' | 'quiet'
  readonly message: string
  readonly action: PreviewNoticeAction
} {
  const target = targetNumber === null ? '目标台词' : `第 ${targetNumber} 句`
  if (update.status === 'kept') {
    return { tone: 'ok', message: `预览已回到${target}。`, action: 'none' }
  }
  if (update.status === 'failed') {
    if (update.failure.code === 'branchChoiceRequired') {
      return {
        tone: 'warning',
        message: `已保存。${target}在分支选项之后，预览没有到达。`,
        action: 'none'
      }
    }
    if (
      update.failure.code === 'staleRuntimeGeneration' ||
      update.failure.code === 'runtimeNotPrepared' ||
      update.failure.code === 'prepareAlreadyDone'
    ) {
      return {
        tone: 'warning',
        message: `已保存。预览没有同步到${target}，重新打开预览可以恢复。`,
        action: 'reopen'
      }
    }
    return {
      tone: 'warning',
      message: `已保存。预览没有回到${target}。`,
      action: 'retryLocate'
    }
  }
  if (update.reason === 'stageNeverPrepared') {
    return { tone: 'quiet', message: '已保存。舞台还没有准备过，预览没有更新。', action: 'none' }
  }
  if (update.reason === 'runtimeNotReady') {
    return {
      tone: 'warning',
      message: `已保存。舞台还没有连接，预览没有回到${target}。`,
      action: 'retryLocate'
    }
  }
  return {
    tone: 'warning',
    message: `已保存。预览已经关闭，重新打开预览可以继续。`,
    action: 'reopen'
  }
}

export function saveFailureAction(
  failure: PreviewFailureView
): 'retry' | 'querySettlement' | 'reopen' | 'none' {
  if (failure.code === 'contentLocked') return 'none'
  if (
    failure.code === 'contentBasisChanged' ||
    failure.code === 'sessionClosed' ||
    failure.code === 'sessionNotFound' ||
    failure.code === 'dialogueObjectInvalid' ||
    failure.code === 'saveSettlementConflict'
  ) {
    return 'reopen'
  }
  if (failure.code === 'saveOutcomeUnknown' || failure.code === 'previewUpdatePending') {
    return 'querySettlement'
  }
  if (failure.code === 'engineCapabilityUnavailable') return 'none'
  return 'retry'
}

export function prepareFailureAction(failure: PreviewFailureView): 'prepare' | 'reopen' | 'none' {
  if (
    failure.code === 'prepareAlreadyDone' ||
    failure.code === 'sessionClosed' ||
    failure.code === 'sessionNotFound' ||
    failure.code === 'contentBasisChanged'
  ) {
    return 'reopen'
  }
  if (failure.code === 'engineCapabilityUnavailable') return 'none'
  return 'prepare'
}

export function selectFailureAction(failure: PreviewFailureView): 'locate' | 'reopen' | 'none' {
  if (
    failure.code === 'runtimeNotPrepared' ||
    failure.code === 'runtimeDisconnected' ||
    failure.code === 'sessionClosed' ||
    failure.code === 'sessionNotFound' ||
    failure.code === 'contentBasisChanged' ||
    failure.code === 'staleRuntimeGeneration' ||
    failure.code === 'prepareAlreadyDone'
  ) {
    return 'reopen'
  }
  if (failure.code === 'branchChoiceRequired' || failure.code === 'engineCapabilityUnavailable') {
    return 'none'
  }
  return 'locate'
}

export function settlementCopy(settlement: DialogueSaveSettlementVO): {
  readonly tone: 'ok' | 'error' | 'busy'
  readonly message: string
} {
  if (settlement.status === 'saved') {
    return { tone: 'ok', message: '保存已核对，修改已经写入场景。' }
  }
  if (settlement.status === 'unchanged') {
    return { tone: 'ok', message: '保存已核对，场景内容没有变化。' }
  }
  if (settlement.status === 'pendingVerification') {
    return { tone: 'busy', message: '保存结果仍在核对，请稍后再查一次。' }
  }
  if (settlement.status === 'notCommitted' || settlement.status === 'conflict') {
    return { tone: 'error', message: failureFromError(settlement.failure).message }
  }
  return { tone: 'error', message: '没有找到这次保存记录，内容仍保留在左侧。' }
}

export const settlementQueryFailureNote = '查询失败，请稍后再试'

function queryClock(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

export function settlementPendingQueryNote(now: Date): string {
  return `已于 ${queryClock(now)} 重新查询，仍在核对`
}

export type SettlementQueryResultVO = {
  readonly code: number
  readonly data?: DialogueSaveSettlementVO
}

export type SettlementQueryOutcome =
  | {
      readonly kind: 'saved'
      readonly settlement: Extract<DialogueSaveSettlementVO, { status: 'saved' }>
    }
  | {
      readonly kind: 'unchanged'
      readonly settlement: Extract<DialogueSaveSettlementVO, { status: 'unchanged' }>
    }
  | {
      readonly kind: 'pending'
      readonly settlement: Extract<DialogueSaveSettlementVO, { status: 'pendingVerification' }>
      readonly queryNote: string
    }
  | { readonly kind: 'error'; readonly queryNote: string }
  | {
      readonly kind: 'settled'
      readonly settlement: Extract<
        DialogueSaveSettlementVO,
        { status: 'notCommitted' | 'conflict' | 'notFound' }
      >
    }

/** 把一次「查看结果」的返回归成界面可用的结果；查询失败与仍在核对都要给用户可见反馈。 */
export function settlementQueryOutcome(
  result: SettlementQueryResultVO,
  now: Date
): SettlementQueryOutcome {
  if (result.code !== ErrorCodes.success || result.data === undefined) {
    return { kind: 'error', queryNote: settlementQueryFailureNote }
  }
  const settlement = result.data
  if (settlement.status === 'saved') return { kind: 'saved', settlement }
  if (settlement.status === 'unchanged') return { kind: 'unchanged', settlement }
  if (settlement.status === 'pendingVerification') {
    return { kind: 'pending', settlement, queryNote: settlementPendingQueryNote(now) }
  }
  return { kind: 'settled', settlement }
}

export function blockedAvailabilityCopy(
  reason: 'noArtifact' | 'sceneUnavailable' | 'readUnavailable'
): {
  readonly title: string
  readonly copy: string
} {
  if (reason === 'noArtifact') {
    return {
      title: '这个场景还没有可预览的内容',
      copy: '先在场景画布生成并保存一次，再回来试玩。'
    }
  }
  if (reason === 'sceneUnavailable') {
    return {
      title: '当前场景不可用',
      copy: '返回工作台后重新打开这个场景，再进入试玩预览。'
    }
  }
  return {
    title: '暂时读不到预览内容',
    copy: '产物可能正在更新。可以重新检查，或返回工作台稍后再试。'
  }
}

export const emptySceneCopy = {
  title: '这个场景还没有可试玩的台词',
  copy: '先在场景画布生成并保存一次，再回来试玩。'
} as const
