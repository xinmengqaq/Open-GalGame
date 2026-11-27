import { useMemo } from 'react'

import { SceneCanvasErrorCodes } from '@common/errors/SceneCanvasErrorCodes'

import type { FailureState } from '../../feedback/failure'
import { CONTENT_DAMAGED_CODE, UNSUPPORTED_FORMAT_CODE } from '../../feedback/projectFilesFeedback'
import { useWorkbenchSessionStore } from './workbenchSession.store'
import type { WorkspaceLoadStatus } from './workbenchSession.types'

export type WorkbenchStateKind = 'ready' | 'reading' | 'read-failed' | 'damaged' | 'empty'

export type WorkbenchStateScope = 'workspace' | 'catalog' | 'arrangement'

export type WorkbenchStateTone = 'ready' | 'reading' | 'empty' | 'warning' | 'danger'

export type WorkbenchStateIntent = 'reload' | 'inspect'

export type WorkbenchStateAction = {
  intent: WorkbenchStateIntent
  label: string
  emphasis: 'primary' | 'secondary'
}

export type WorkbenchState = {
  kind: WorkbenchStateKind
  scope: WorkbenchStateScope
  tone: WorkbenchStateTone
  subject: string
  title: string
  detail: string | null
  nextStep: string
  actions: readonly WorkbenchStateAction[]
  failureCode: number | null
}

export type WorkbenchStateInput = {
  catalogStatus: WorkspaceLoadStatus
  catalogError: FailureState | null
  arrangementStatus: WorkspaceLoadStatus
  arrangementError: FailureState | null
  arrangementCardCount?: number
}

export function isDamagedFailureCode(code: number | null | undefined): boolean {
  return (
    code === CONTENT_DAMAGED_CODE ||
    code === UNSUPPORTED_FORMAT_CODE ||
    code === SceneCanvasErrorCodes.contentDamaged ||
    code === SceneCanvasErrorCodes.unsupportedFormat
  )
}

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

export function arrangementStateOf(
  status: WorkspaceLoadStatus,
  error: FailureState | null
): WorkbenchState {
  if (status === 'failed' || error !== null) return failureStateOf('arrangement', status, error)
  if (status === 'idle' || status === 'loading') return readingStateOf('arrangement')
  if (status === 'empty') return emptyStateOf('arrangement')
  return readyStateOf('arrangement')
}

export function catalogStateOf(
  status: WorkspaceLoadStatus,
  error: FailureState | null
): WorkbenchState {
  if (status === 'failed' || error !== null) return failureStateOf('catalog', status, error)
  if (status === 'idle' || status === 'loading') return readingStateOf('catalog')
  if (status === 'empty') return emptyStateOf('catalog')
  return readyStateOf('catalog')
}

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
      nextStep: '重新读取；仍然失败时检查工程诊断。',
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
    code === UNSUPPORTED_FORMAT_CODE || code === SceneCanvasErrorCodes.unsupportedFormat
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
      ? '检查工程诊断，确认损坏范围。'
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
    nextStep: '',
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
    nextStep: '',
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
    nextStep: '',
    actions: [],
    failureCode: null
  }
}
