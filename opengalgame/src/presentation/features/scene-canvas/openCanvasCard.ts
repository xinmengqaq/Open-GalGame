import type { ProjectFileScopeDTO } from '@application/project-files/dto/ProjectFilesDTO'
import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import { toast } from 'sonner'

import { failureOf, requireSuccess } from '../../feedback/failure'
import { sourceFactsOf } from '../workbench-session/workbenchSessionSelectors'
import { useWorkbenchSessionStore } from '../workbench-session/workbenchSession.store'
import type { SessionCard } from '../workbench-session/workbenchSession.types'

const interactiveSelector =
  'button, input, textarea, select, a, [contenteditable=""], [contenteditable="true"], .react-flow__handle, .react-flow__resize-control, .react-flow__node-resizer'

export type CanvasCardOpenAction =
  { kind: 'document'; cardId: string } | { kind: 'file'; request: ProjectFileScopeDTO }

/**
 * 双击卡面时决定打开方式。文档走内置文档层，图片、音频、视频走系统程序。
 * 端口、缩放和表单控件不打开；连接中、断开或不可读取来源不伪造打开。
 */
export function canvasCardOpenAction(
  card: SessionCard,
  eventTarget: EventTarget | null,
  connecting: boolean
): CanvasCardOpenAction | null {
  if (connecting || isCanvasOpenControl(eventTarget)) return null
  if (
    card.kind !== 'document' &&
    card.kind !== 'image' &&
    card.kind !== 'audio' &&
    card.kind !== 'video'
  ) {
    return null
  }
  const state = useWorkbenchSessionStore.getState()
  if (state.projectId.length === 0 || card.sourceId.length === 0) return null
  const source = sourceFactsOf(state, card.sourceId)
  if (source.disconnected || !source.readable) return null
  if (card.kind === 'document') return { kind: 'document', cardId: card.cardId }
  return { kind: 'file', request: { projectId: state.projectId, sourceId: card.sourceId } }
}

function isCanvasOpenControl(target: EventTarget | null): boolean {
  return typeof Element !== 'undefined' && target instanceof Element
    ? target.closest(interactiveSelector) !== null
    : false
}

/** 用系统默认程序打开当前工程来源。迟到结果不提示到已切换的工程。 */
export async function openCanvasSourceFile(
  client: ProjectFilesClient,
  request: ProjectFileScopeDTO
): Promise<void> {
  try {
    requireSuccess(await client.openProjectFile(request))
  } catch (error) {
    if (useWorkbenchSessionStore.getState().projectId !== request.projectId) return
    toast(failureOf(error).msg)
  }
}
