import { ReactFlowProvider, useReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useRef, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import {
  PROJECT_WORKSPACE_NOT_READY_CODE,
  workbenchFeedback
} from '../../feedback/workbenchFeedback'
import {
  canvasSafeAreaOf,
  emptyWorkbenchInsets,
  type RegisterWorkbenchInset,
  type WorkbenchLayoutInsets
} from '../../pages/workbench/shell/workbenchLayout'
import { defaultCardSize } from '../workbench-session/contentKindLabel'
import { useWorkbenchCommands } from '../workbench-session/workbenchCommandsContext'
import { useWorkbenchSessionStore } from '../workbench-session/workbenchSession.store'
import type { SessionFieldKind } from '../workbench-session/webgalPreset'
import { CanvasNodeContext } from './canvasNodeContext'
import { findFreeCanvasPosition } from './canvasPlacement'
import { EditCanvasCardDialog } from './EditCanvasCardDialog'
import { RelationDialog } from './RelationDialog'
import { SceneCanvasContextMenu } from './SceneCanvasContextMenu'
import { SceneCanvasFailureState } from './SceneCanvasFailureState'
import { SceneCanvasToolbar } from './SceneCanvasToolbar'
import { SceneCanvasViewport } from './SceneCanvasViewport'
import { useSceneCanvas } from './useSceneCanvas'
import { useSceneCanvasMotion } from './useSceneCanvasMotion'
import styles from './SceneCanvas.module.css'

interface SceneCanvasProps {
  client: ProjectFilesClient
  onInspect: () => void
  onReload: () => void
  layoutInsets?: WorkbenchLayoutInsets
  registerInset?: RegisterWorkbenchInset
  noticeSlot?: HTMLElement | null
}

export function SceneCanvas({
  client,
  onInspect,
  onReload,
  layoutInsets,
  registerInset,
  noticeSlot
}: SceneCanvasProps): ReactElement {
  return (
    <ReactFlowProvider>
      <SceneCanvasBody
        client={client}
        onInspect={onInspect}
        onReload={onReload}
        layoutInsets={layoutInsets}
        registerInset={registerInset}
        noticeSlot={noticeSlot}
      />
    </ReactFlowProvider>
  )
}

function SceneCanvasBody({
  client,
  onInspect,
  onReload,
  layoutInsets,
  registerInset,
  noticeSlot
}: SceneCanvasProps): ReactElement {
  const commands = useWorkbenchCommands()
  const flow = useReactFlow()
  const stageRef = useRef<HTMLElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const addQueue = useRef<Promise<void>>(Promise.resolve())
  const canvas = useSceneCanvas(viewportRef, client)
  const cards = useWorkbenchSessionStore((state) => state.cards)
  const relations = useWorkbenchSessionStore((state) => state.relations)
  const status = useWorkbenchSessionStore((state) => state.arrangementStatus)
  const error = useWorkbenchSessionStore((state) => state.arrangementError)
  const relationKey = relations
    .map(
      (relation) => `${relation.relationId}:${relation.specificName}:${relation.recordCardId ?? ''}`
    )
    .join('|')
  const safeArea = canvasSafeAreaOf(layoutInsets ?? emptyWorkbenchInsets)

  useSceneCanvasMotion({
    root: stageRef,
    relationKey,
    emptyVisible: cards.length === 0 && status !== 'failed'
  })

  function addCard(kind: 'prompt' | SessionFieldKind): void {
    const view = flow.getViewport()
    const size = defaultCardSize(kind)
    const width = viewportRef.current?.clientWidth || stageRef.current?.clientWidth || 960
    const height = viewportRef.current?.clientHeight || stageRef.current?.clientHeight || 620
    const preferred = {
      x: (width / 2 - view.x) / view.zoom - size.width / 2,
      y: (height / 2 - view.y) / view.zoom - size.height / 2
    }
    addQueue.current = addQueue.current
      .then(
        async () => {
          const latestCards = useWorkbenchSessionStore.getState().cards
          const { position, overlapping } = findFreeCanvasPosition(latestCards, preferred, size)
          const cardId =
            kind === 'prompt'
              ? await commands.createPromptCard(position)
              : await commands.createFieldCard(kind, position)
          if (!cardId) return
          const label = kind === 'prompt' ? '提示词卡' : kind === 'animation' ? '动画卡' : '特效卡'
          canvas.announce(
            overlapping ? workbenchFeedback.canvasPlacementOverlap : `已添加${label}`,
            overlapping ? 'error' : 'info'
          )
        },
        () => undefined
      )
      .catch(() => undefined)
  }

  if (status === 'failed' && error) {
    if (error.code === PROJECT_WORKSPACE_NOT_READY_CODE) return <></>
    return (
      <section ref={stageRef} className={styles.stage} data-state="failed">
        <SceneCanvasFailureState error={error} onInspect={onInspect} onReload={onReload} />
      </section>
    )
  }

  const notice = canvas.notice ? (
    <div
      key={canvas.notice.key}
      className={styles.notice}
      data-tone={canvas.notice.tone}
      data-placement={noticeSlot ? 'shelf' : 'canvas'}
      role="status"
      aria-live="polite"
    >
      <span className={styles.noticeDot} aria-hidden="true" />
      {canvas.notice.text}
    </div>
  ) : null

  return (
    <CanvasNodeContext.Provider
      value={{
        beginLayoutInteract: canvas.beginLayoutInteract,
        commitCardLayout: canvas.commitCardLayout,
        openRelation: canvas.openRelation,
        detachRecord: canvas.detachRecord,
        openEdit: canvas.openEdit,
        activeRelationId: canvas.relation?.relationId ?? null,
        isConnecting: canvas.isConnecting,
        connectingFromCardId: canvas.connectingFromCardId,
        connectingFromKind: canvas.connectingFromKind,
        rejectedCardId: canvas.rejectedCardId
      }}
    >
      <section ref={stageRef} className={styles.stage} aria-label="场景画布">
        <SceneCanvasViewport
          client={client}
          surfaceRef={viewportRef}
          canvas={canvas}
          safeArea={safeArea}
          onAddPrompt={() => addCard('prompt')}
          onAttachRecord={canvas.attachRecordToAnchor}
        />
        {notice && noticeSlot ? createPortal(notice, noticeSlot) : notice}
        <SceneCanvasToolbar
          onAddPrompt={() => addCard('prompt')}
          onAddAnimation={() => addCard('animation')}
          onAddEffect={() => addCard('effect')}
          registerInset={registerInset}
        />
        <SceneCanvasContextMenu
          menu={canvas.menu}
          onClose={canvas.closeMenu}
          onEdit={() => {
            if (canvas.menu) canvas.openEdit(canvas.menu.cardId)
          }}
          onCopy={() => {
            if (canvas.menu) void commands.copyCard(canvas.menu.cardId)
            canvas.closeMenu()
          }}
          onDelete={() => {
            if (canvas.menu) void commands.deleteCard(canvas.menu.cardId)
            canvas.closeMenu()
          }}
        />
        <EditCanvasCardDialog card={canvas.editingCard} onClose={canvas.closeEdit} />
        <RelationDialog relation={canvas.relation} onClose={canvas.closeRelation} />
      </section>
    </CanvasNodeContext.Provider>
  )
}
