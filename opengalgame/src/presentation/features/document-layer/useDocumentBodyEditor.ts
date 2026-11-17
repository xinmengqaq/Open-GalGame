import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'

import type { ProjectInputSourceVO } from '@application/project-files/vo/ProjectInputSourceVO'
import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import { DOCUMENT_BODY_CHANGED_CODE, workbenchFeedback } from '../../feedback/workbenchFeedback'
import { failureOf, requireSuccess } from '../../feedback/failure'
import { useWorkbenchSessionStore } from '../workbench-session/workbenchSession.store'
import {
  catalogProjectNeedsRecovery,
  isUncertainCatalogWrite,
  resolveCatalogWrite
} from '../input-catalog/catalogWrites'
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

type DocumentBodyBaseline = {
  version: string | undefined
  editable: boolean
  body: string
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
  const [draft, setDraft] = useState<string | null>(() => (editable ? view.body : null))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const savingRef = useRef(false)
  const baseline: DocumentBodyBaseline = {
    version: detail?.version,
    editable,
    body: view.body
  }
  const [applied, setApplied] = useState<DocumentBodyBaseline>(baseline)
  const reloadView = view.reload

  // 来源版本、可编辑性或正文变化时，用当前正文重建草稿并清掉上一轮保存失败。
  // 按身份快照在渲染期调整状态，避免在 effect 里同步 setState 触发级联渲染。
  if (
    applied.version !== baseline.version ||
    applied.editable !== baseline.editable ||
    applied.body !== baseline.body
  ) {
    setApplied(baseline)
    setDraft(editable ? view.body : null)
    setError(null)
    setConflict(false)
  }

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
    const projectId = useWorkbenchSessionStore.getState().projectId
    if (catalogProjectNeedsRecovery(projectId)) {
      setError(workbenchFeedback.catalogWriteNeedsRecovery)
      return
    }
    const operationId = crypto.randomUUID()
    const stillCurrent = (): boolean =>
      useWorkbenchSessionStore.getState().projectId === projectId
    savingRef.current = true
    setSaving(true)
    setError(null)
    setConflict(false)
    try {
      const saved = requireSuccess(
        await client.updateProjectTextFileBody({
          projectId,
          operationId,
          sourceId: card.sourceId,
          expectedSourceVersion: expectedVersion,
          content: { textKind: 'document', body: check.body }
        })
      )
      if (stillCurrent()) {
        useWorkbenchSessionStore.getState().putSourceDetails([saved])
        toast(workbenchFeedback.saveSucceeded)
      }
    } catch (failure) {
      const state = failureOf(failure)
      if (isUncertainCatalogWrite(state)) {
        try {
          await resolveCatalogWrite(client, projectId, operationId)
        } catch (resolveFailure) {
          if (stillCurrent()) {
            setError(failureOf(resolveFailure).msg || workbenchFeedback.saveFailed)
          }
          return
        }
        if (stillCurrent()) {
          reloadView()
          toast(workbenchFeedback.saveSucceeded)
        }
      } else if (state.code === DOCUMENT_BODY_CHANGED_CODE) {
        setConflict(true)
        setError(workbenchFeedback.documentBodyChanged)
      } else {
        setError(state.msg || workbenchFeedback.saveFailed)
      }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [card.sourceId, client, detail?.version, draft, reloadView])

  const reloadLatest = useCallback(() => {
    setConflict(false)
    setError(null)
    reloadView()
  }, [reloadView])

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
