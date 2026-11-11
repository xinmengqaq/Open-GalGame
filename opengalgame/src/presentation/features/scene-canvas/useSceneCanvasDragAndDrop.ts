import { useCallback, useState, type DragEvent } from 'react'
import { useReactFlow } from '@xyflow/react'
import { toast } from 'sonner'

import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import { requireSuccess } from '../../feedback/failure'
import { workbenchFeedback } from '../../feedback/workbenchFeedback'
import { useWorkbenchCommands } from '../workbench-session/workbenchCommandsContext'
import { useWorkbenchSessionStore } from '../workbench-session/workbenchSession.store'
import {
  SOURCE_DRAG_MIME,
  type InputSourceDragPayload
} from '../workbench-session/workbenchSession.types'

export function parseSourceDrag(event: DragEvent): InputSourceDragPayload | null {
  const raw = event.dataTransfer.getData(SOURCE_DRAG_MIME)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as InputSourceDragPayload
    if (!parsed.projectId || !parsed.sourceId) return null
    return parsed
  } catch {
    return null
  }
}

export function useSceneCanvasDragAndDrop(client: ProjectFilesClient): {
  draggingOver: boolean
  onDragOver: (event: DragEvent) => void
  onDragLeave: () => void
  onDrop: (event: DragEvent) => void
} {
  const commands = useWorkbenchCommands()
  const { screenToFlowPosition } = useReactFlow()
  const [draggingOver, setDraggingOver] = useState(false)

  const onDrop = useCallback(
    async (event: DragEvent) => {
      event.preventDefault()
      setDraggingOver(false)
      const payload = parseSourceDrag(event)
      const store = useWorkbenchSessionStore.getState()
      if (!payload || payload.projectId !== store.projectId) return
      const point = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      const result = await commands.createSourceCard(payload.sourceId, {
        x: point.x,
        y: point.y
      })
      if (result === 'unreadable') {
        toast(workbenchFeedback.dropUnreadable)
        return
      }
      if (result === 'missing') {
        toast(workbenchFeedback.sourceMissing)
        return
      }
      if (result === 'failed') return
      toast(workbenchFeedback.cardAdded)
      const projectId = useWorkbenchSessionStore.getState().projectId
      try {
        const snapshot = requireSuccess(
          await client.readProjectInputSources({
            projectId,
            sourceIds: [payload.sourceId]
          })
        )
        if (useWorkbenchSessionStore.getState().projectId !== projectId) return
        useWorkbenchSessionStore.getState().putSourceDetails(snapshot.sources)
      } catch {
        /* 详情失败不撤销建卡，来源状态由目录摘要判断。 */
      }
    },
    [client, commands, screenToFlowPosition]
  )

  return {
    draggingOver,
    onDragOver: (event) => {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      setDraggingOver(true)
    },
    onDragLeave: () => setDraggingOver(false),
    onDrop: (event) => {
      void onDrop(event)
    }
  }
}
