import { toast } from 'sonner'

import type { SceneCanvasClient } from '@interfaces/scene-canvas/client/SceneCanvasClient'
import { failureOf, requireSuccess } from '../../feedback/failure'
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
}

export function createWorkbenchPromptEdits(deps: WorkbenchPromptEditDeps): WorkbenchPromptEdits {
  const store = useWorkbenchSessionStore
  const pendingCards = new Set<string>()
  const bursts = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null

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
    let chain: Promise<void> = Promise.resolve()
    for (const cardId of cards) {
      chain = chain.then(() => send(cardId))
    }
    await chain
  }

  function send(cardId: string): Promise<void> {
    return deps.enqueue(async () => {
      const state = store.getState()
      const card = state.cards.find((item) => item.cardId === cardId)
      if (!card || card.kind !== 'prompt') return
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
            body: card.body
          })
        )
        if (store.getState().projectId !== state.projectId) return
        store.getState().applyServerArrangement(arrangement, capture)
        const current = store.getState()
        if ((current.cardEditRevisions[cardId] ?? 0) <= capture.revision) {
          bursts.delete(cardId)
        }
        deps.noteServerResult()
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
