import { toast } from 'sonner'

import type { SceneCanvasClient } from '@interfaces/scene-canvas/client/SceneCanvasClient'
import { failureOf, requireSuccess } from '../../feedback/failure'
import type { WorkbenchActionScope } from './workbenchActionObservers'
import { promptReferenceFailureOf } from './promptReferences'
import { draftArrangementOf } from './workbenchSessionMapper'
import { useWorkbenchSessionStore } from './workbenchSession.store'

const PROMPT_FLUSH_DELAY_MS = 450

export interface WorkbenchPromptEdits {
  editPromptBody(cardId: string, body: string): void
  flush(): Promise<void>
  discardPending(): void
  dispose(): void
}

interface WorkbenchPromptEditDeps {
  client: SceneCanvasClient
  enqueue<T>(task: () => Promise<T>): Promise<T>
  noteLocalEdit(): void
  noteServerResult(): void
  /** 服务端已确认写入后回调；作用域捕获自发起保存时的会话，供观察源丢弃迟到结果。 */
  onSaved(cardId: string, scope: WorkbenchActionScope): void
}

export function createWorkbenchPromptEdits(deps: WorkbenchPromptEditDeps): WorkbenchPromptEdits {
  const store = useWorkbenchSessionStore
  const pendingCards = new Set<string>()
  const bursts = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  /** 撤销、重做、历史写或销毁会作废尚未落定草稿的保存报告。 */
  let invalidations = 0

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function scheduleFlush(): void {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, PROMPT_FLUSH_DELAY_MS)
  }

  async function flush(): Promise<void> {
    clearTimer()
    if (pendingCards.size === 0) return
    const cards = [...pendingCards]
    pendingCards.clear()
    const invalidation = invalidations
    let chain: Promise<void> = Promise.resolve()
    for (const cardId of cards) {
      chain = chain.then(() => send(cardId, invalidation))
    }
    await chain
  }

  function send(cardId: string, invalidation: number): Promise<void> {
    return deps.enqueue(async () => {
      const state = store.getState()
      const card = state.cards.find((item) => item.cardId === cardId)
      if (!card || card.kind !== 'prompt') return
      if (state.projectId.length === 0 || state.sceneId.length === 0 || state.canvasId.length === 0) {
        return
      }
      const body = card.body
      const scope: WorkbenchActionScope = {
        projectId: state.projectId,
        sceneId: state.sceneId,
        canvasId: state.canvasId
      }
      const capture = {
        revision: state.revision,
        structuralRevision: state.structuralRevision
      }
      try {
        const arrangement = requireSuccess(
          await deps.client.editPromptBody({
            projectId: state.projectId,
            sceneId: state.sceneId,
            canvasId: state.canvasId,
            arrangement: draftArrangementOf(state),
            cardId,
            body
          })
        )
        const current = store.getState()
        // 跨工程/场景/画布的迟到响应在触碰当前会话前返回：既不把旧工程结果合并
        // 进新工程，也不清理新工程的草稿缓存或替新工程启动自动保存。
        if (
          current.projectId !== state.projectId ||
          current.sceneId !== state.sceneId ||
          current.canvasId !== state.canvasId
        ) {
          return
        }
        const applied = current.applyServerArrangement(arrangement, capture)
        const after = store.getState()
        if ((after.cardEditRevisions[cardId] ?? 0) <= capture.revision) {
          bursts.delete(cardId)
        }
        deps.noteServerResult()
        const adoptedCard = after.cards.find((item) => item.cardId === cardId)
        const adoptedBody = adoptedCard?.kind === 'prompt' ? adoptedCard.body : ''
        // 只报告本次会话真正采纳、未被后续编辑或撤销替代的非空正文；
        // 空正文和迟到响应仍按原样写入工程，但不再推进教程。
        const adopted =
          applied &&
          invalidation === invalidations &&
          (after.cardEditRevisions[cardId] ?? 0) <= capture.revision &&
          body.trim().length > 0 &&
          adoptedBody.trim().length > 0
        if (adopted) deps.onSaved(cardId, scope)
      } catch (error) {
        const failure = failureOf(error)
        const referenceFailure = promptReferenceFailureOf(failure)
        if (referenceFailure) {
          store.getState().setPromptReferenceAlert({ message: referenceFailure.text, cardId })
        }
        toast(referenceFailure?.text ?? failure.msg)
      }
    })
  }

  function editPromptBody(cardId: string, body: string): void {
    const first = !bursts.has(cardId)
    if (!store.getState().setPromptBodyDraft(cardId, body, first)) return
    bursts.add(cardId)
    pendingCards.add(cardId)
    scheduleFlush()
    deps.noteLocalEdit()
  }

  function discardPending(): void {
    invalidations += 1
    clearTimer()
    pendingCards.clear()
    bursts.clear()
  }

  return {
    editPromptBody,
    flush,
    discardPending,
    dispose: discardPending
  }
}
