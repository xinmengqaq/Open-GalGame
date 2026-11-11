import { useMemo } from 'react'

import type { FailureState } from '../../feedback/failure'
import { CONTENT_DAMAGED_CODE, UNSUPPORTED_FORMAT_CODE } from '../../feedback/projectFilesFeedback'
import { useWorkbenchSessionStore } from './workbenchSession.store'
import type { WorkspaceLoadStatus } from './workbenchSession.types'

/**
 * 工作台全局读取状态。空画布、读取失败与编排损坏是三件事：
 * 空画布可以开始编排，读取失败可以重试，损坏需要检查工程而不是假装修复。
 */
export type WorkbenchStateKind = 'ready' | 'reading' | 'read-failed' | 'damaged' | 'empty'

/** 状态属于哪个对象。顶栏用它说明“哪一部分没有读到”。 */
export type WorkbenchStateScope = 'workspace' | 'catalog' | 'arrangement'

export type WorkbenchStateTone = 'ready' | 'reading' | 'empty' | 'warning' | 'danger'

/** 状态视图可映射到既有动作，不在状态模型里保存回调。 */
export type WorkbenchStateIntent = 'reload' | 'inspect'

export type WorkbenchStateAction = {
  intent: WorkbenchStateIntent
  label: string
  emphasis: 'primary' | 'secondary'
}

/** 只含状态视图需要的字段，不持有目录、卡片或关系对象。 */
export type WorkbenchState = {
  kind: WorkbenchStateKind
  scope: WorkbenchStateScope
  tone: WorkbenchStateTone
  /** 对象：工程与画布 / 画布编排 / 来源目录。 */
  subject: string
  /** 当前状态。 */
  title: string
  /** 失败原因，没有失败时为 null。 */
  detail: string | null
  /** 下一步可以做什么，不做没有实现的能力。 */
  nextStep: string
  /** 按呈现顺序排列的动作意图，空数组表示不提供动作。 */
  actions: readonly WorkbenchStateAction[]
  /** 领域失败码，仅用于诊断与状态签名；不从消息文本猜测状态。 */
  failureCode: number | null
}

export type WorkbenchStateInput = {
  catalogStatus: WorkspaceLoadStatus
  catalogError: FailureState | null
  arrangementStatus: WorkspaceLoadStatus
  arrangementError: FailureState | null
  /**
   * 已加载画布的卡片数。ready/empty 按它归一化；
   * 不传时保持只看 arrangementStatus 的旧语义。
   */
  arrangementCardCount?: number
}

/** 与 domain/scene-canvas/errors/SceneCanvasErrorCodes 对齐；表现层只按结构化码判断。 */
const SCENE_CANVAS_CONTENT_DAMAGED_CODE = 4416
const SCENE_CANVAS_UNSUPPORTED_FORMAT_CODE = 4417

/**
 * 是否属于“内容/格式已经不能按当前版本读取”，需要检查工程而不是重试。
 * 只按失败码判断，不读取失败消息。
 * @param code - 失败码。
 */
export function isDamagedFailureCode(code: number | null | undefined): boolean {
  return (
    code === CONTENT_DAMAGED_CODE ||
    code === UNSUPPORTED_FORMAT_CODE ||
    code === SCENE_CANVAS_CONTENT_DAMAGED_CODE ||
    code === SCENE_CANVAS_UNSUPPORTED_FORMAT_CODE
  )
}

/**
 * 从真实的目录与画布读取状态推导一个全局状态。
 * 画布失败优先于目录失败，失败优先于读取中，读取中优先于空态。
 * @param input - 目录与画布的读取状态。
 */
export function workbenchStateOf(input: WorkbenchStateInput): WorkbenchState {
  if (input.arrangementStatus === 'failed' || input.arrangementError !== null) {
    return arrangementStateOf(input.arrangementStatus, input.arrangementError)
  }
  if (input.catalogStatus === 'failed' || input.catalogError !== null) {
    return catalogStateOf(input.catalogStatus, input.catalogError)
  }
  if (input.arrangementStatus === 'idle' || input.arrangementStatus === 'loading')
    return arrangementStateOf(input.arrangementStatus, input.arrangementError)
  if (
    input.arrangementCardCount === undefined &&
    (input.catalogStatus === 'idle' || input.catalogStatus === 'loading')
  ) {
    return catalogStateOf(input.catalogStatus, input.catalogError)
  }
  const settled =
    input.arrangementCardCount === undefined
      ? input.arrangementStatus
      : input.arrangementCardCount > 0
        ? 'ready'
        : 'empty'
  if (settled === 'empty') return emptyStateOf('workspace')
  return readyStateOf('workspace')
}

/**
 * 画布状态面使用的唯一映射；读取失败与损坏不会回落到空画布。
 * @param status - 画布读取状态。
 * @param error - 画布读取失败。
 */
export function arrangementStateOf(
  status: WorkspaceLoadStatus,
  error: FailureState | null
): WorkbenchState {
  if (status === 'failed' || error !== null) return failureStateOf('arrangement', status, error)
  if (status === 'idle' || status === 'loading') return readingStateOf('arrangement')
  if (status === 'empty') return emptyStateOf('arrangement')
  return readyStateOf('arrangement')
}

/**
 * 目录面板使用的唯一映射；空目录是可导入素材的空态，不是读取失败。
 * @param status - 目录读取状态。
 * @param error - 目录读取失败。
 */
export function catalogStateOf(
  status: WorkspaceLoadStatus,
  error: FailureState | null
): WorkbenchState {
  if (status === 'failed' || error !== null) return failureStateOf('catalog', status, error)
  if (status === 'idle' || status === 'loading') return readingStateOf('catalog')
  if (status === 'empty') return emptyStateOf('catalog')
  return readyStateOf('catalog')
}

/** 订阅会话读取字段和卡片数，供顶栏状态视图直接使用；不新建全局 store。 */
export function useWorkbenchState(): WorkbenchState {
  const catalogStatus = useWorkbenchSessionStore((state) => state.catalogStatus)
  const catalogError = useWorkbenchSessionStore((state) => state.catalogError)
  const arrangementStatus = useWorkbenchSessionStore((state) => state.arrangementStatus)
  const arrangementError = useWorkbenchSessionStore((state) => state.arrangementError)
  const arrangementCardCount = useWorkbenchSessionStore((state) => state.cards.length)
  return useMemo(
    () =>
      workbenchStateOf({
        catalogStatus,
        catalogError,
        arrangementStatus,
        arrangementError,
        arrangementCardCount
      }),
    [catalogStatus, catalogError, arrangementStatus, arrangementError, arrangementCardCount]
  )
}

function failureStateOf(
  scope: 'catalog' | 'arrangement',
  status: WorkspaceLoadStatus,
  error: FailureState | null
): WorkbenchState {
  const code = error?.code ?? null
  if (isDamagedFailureCode(code)) return damagedStateOf(scope, code, error)

  const stale = scope === 'catalog' && (status === 'ready' || status === 'empty') && error !== null
  const detail = error?.msg ?? null
  if (scope === 'arrangement') {
    return {
      kind: 'read-failed',
      scope,
      tone: 'warning',
      subject: '画布编排',
      title: '画布编排读取失败',
      detail,
      nextStep: '重新读取通常可以恢复；若仍然失败，检查工程诊断。',
      actions: [
        { intent: 'inspect', label: '检查工程', emphasis: 'secondary' },
        { intent: 'reload', label: '重新读取', emphasis: 'primary' }
      ],
      failureCode: code
    }
  }

  return {
    kind: 'read-failed',
    scope,
    tone: 'warning',
    subject: '来源目录',
    title: stale ? '来源列表读取失败' : '来源目录读取失败',
    detail: stale && detail ? `${detail} 当前仍显示上次读取结果。` : detail,
    nextStep: stale ? '重新读取来源；目录继续使用上次结果。' : '重新读取来源目录。',
    actions: [{ intent: 'reload', label: '重新读取来源', emphasis: 'primary' }],
    failureCode: code
  }
}

function damagedStateOf(
  scope: 'catalog' | 'arrangement',
  code: number | null,
  error: FailureState | null
): WorkbenchState {
  const arrangement = scope === 'arrangement'
  const formatIssue =
    code === UNSUPPORTED_FORMAT_CODE || code === SCENE_CANVAS_UNSUPPORTED_FORMAT_CODE
  return {
    kind: 'damaged',
    scope,
    tone: 'danger',
    subject: arrangement ? '画布编排' : '来源目录',
    title: arrangement
      ? formatIssue
        ? '画布编排格式不受支持'
        : '画布编排内容损坏'
      : formatIssue
        ? '来源目录格式不受支持'
        : '来源目录内容损坏',
    detail: error?.msg ?? null,
    nextStep: arrangement
      ? '检查工程诊断，确认恢复范围；损坏内容不会被自动覆盖。'
      : '检查工程诊断，确认来源记录；目录内容不会被自动覆盖。',
    actions: [{ intent: 'inspect', label: '检查工程', emphasis: 'primary' }],
    failureCode: code
  }
}

function readingStateOf(scope: 'catalog' | 'arrangement'): WorkbenchState {
  const arrangement = scope === 'arrangement'
  return {
    kind: 'reading',
    scope,
    tone: 'reading',
    subject: arrangement ? '画布编排' : '来源目录',
    title: arrangement ? '正在读取画布编排' : '正在读取来源目录',
    detail: null,
    nextStep: arrangement ? '读取完成后即可继续编排。' : '目录就绪后可以把素材拖入画布。',
    actions: [],
    failureCode: null
  }
}

function readyStateOf(scope: WorkbenchStateScope): WorkbenchState {
  const catalog = scope === 'catalog'
  const arrangement = scope === 'arrangement'
  return {
    kind: 'ready',
    scope,
    tone: 'ready',
    subject: catalog ? '来源目录' : arrangement ? '画布编排' : '工程与画布',
    title: catalog ? '来源目录已就绪' : arrangement ? '画布编排已就绪' : '工程与画布已就绪',
    detail: null,
    nextStep: catalog
      ? '可以把可读取的素材拖入画布。'
      : arrangement
        ? '可以继续编排卡片和关系。'
        : '可以从目录拖入素材，或继续编排画布。',
    actions: [],
    failureCode: null
  }
}

function emptyStateOf(scope: WorkbenchStateScope): WorkbenchState {
  return {
    kind: 'empty',
    scope,
    tone: 'empty',
    subject: scope === 'catalog' ? '来源目录' : scope === 'arrangement' ? '画布编排' : '工程与画布',
    title: scope === 'catalog' ? '来源目录还是空的' : '画布还没有卡片',
    detail: null,
    nextStep:
      scope === 'catalog'
        ? '导入文件或新建文件夹，再把素材拖入画布。'
        : '从目录拖入文本或文件素材，开始编排。',
    actions: [],
    failureCode: null
  }
}
