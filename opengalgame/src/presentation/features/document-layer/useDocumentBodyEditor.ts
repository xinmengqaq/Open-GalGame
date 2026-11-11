import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import type { ProjectInputSourceVO } from '@application/project-files/vo/ProjectInputSourceVO'
import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import { DOCUMENT_BODY_CHANGED_CODE, workbenchFeedback } from '../../feedback/workbenchFeedback'
import { failureOf, requireSuccess } from '../../feedback/failure'
import { useWorkbenchSessionStore } from '../workbench-session/workbenchSession.store'
import type { SessionDocumentCard } from '../workbench-session/workbenchSession.types'
import {
  documentSaveDraft,
  documentsEditable,
  type DocumentSaveDraftFailure
} from './documentBodyDraft'
import type { DocumentBodyView } from './useDocumentLayer'

export type DocumentBodyEditor = {
  editable: boolean
  draft: string | null
  dirty: boolean
  saving: boolean
  error: string | null
  conflict: boolean
  setDraft: (body: string) => void
  save: () => Promise<void>
  reloadLatest: () => void
}

const failureMessage: Record<DocumentSaveDraftFailure, string> = {
  'too-long': workbenchFeedback.documentSaveTooLong,
  'missing-version': workbenchFeedback.documentSaveMissingVersion,
  'unsupported-image': workbenchFeedback.documentSaveUnsupportedImage
}

/**
 * 文档层正文草稿与保存。可编辑性只看 Markdown 文档，纯文本保持只读。
 * 保存成功后把返回来源写回会话缓存；版本冲突只提示，不丢弃本地草稿。
 */
export function useDocumentBodyEditor(
  client: ProjectFilesClient,
  card: SessionDocumentCard,
  view: DocumentBodyView,
  detail?: ProjectInputSourceVO
): DocumentBodyEditor {
  const detailFormat =
    detail && detail.contentKind === 'text' ? detail.importInfo.format : undefined
  const editable =
    documentsEditable({ contentKind: detail?.contentKind, importFormat: detailFormat }) &&
    (view.status === 'ready' || view.status === 'empty')
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const savingRef = useRef(false)

  useEffect(() => {
    setDraft(editable ? view.body : null)
    setError(null)
    setConflict(false)
  }, [detail?.version, editable, view.body])

  const dirty = draft !== null && draft !== view.body

  const save = useCallback(async (): Promise<void> => {
    if (savingRef.current || draft === null) return
    const expectedVersion = detail?.version ?? ''
    const check = documentSaveDraft({ body: draft, expectedVersion })
    if (!check.ok) {
      setConflict(false)
      setError(failureMessage[check.reason])
      return
    }
    savingRef.current = true
    setSaving(true)
    setError(null)
    setConflict(false)
    try {
      const saved = requireSuccess(
        await client.updateProjectTextFileBody({
          projectId: useWorkbenchSessionStore.getState().projectId,
          sourceId: card.sourceId,
          expectedSourceVersion: expectedVersion,
          content: { textKind: 'document', body: check.body }
        })
      )
      useWorkbenchSessionStore.getState().putSourceDetails([saved])
      toast(workbenchFeedback.saveSucceeded)
    } catch (failure) {
      const state = failureOf(failure)
      if (state.code === DOCUMENT_BODY_CHANGED_CODE) {
        setConflict(true)
        setError(workbenchFeedback.documentBodyChanged)
      } else {
        setError(state.msg || workbenchFeedback.saveFailed)
      }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [card.sourceId, client, detail?.version, draft])

  const reloadLatest = useCallback(() => {
    setConflict(false)
    setError(null)
    view.reload()
  }, [view.reload])

  return {
    editable,
    draft,
    dirty,
    saving,
    error,
    conflict,
    setDraft,
    save,
    reloadLatest
  }
}
