import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

import type { ProjectFolderVO } from '@application/project-files/vo/ProjectInputCatalogVO'
import type { ProjectInputSourceSummaryVO } from '@application/project-files/vo/ProjectInputSourceVO'
import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import type { QueryClient } from '@tanstack/react-query'
import { COMMIT_UNCLEAR_CODE } from '../../feedback/projectFilesFeedback'
import { failureOf, requireSuccess } from '../../feedback/failure'
import { workbenchFeedback } from '../../feedback/workbenchFeedback'
import {
  beginCatalogWrite,
  catalogWriteBlockedFor,
  endCatalogWrite,
  holdUnresolvedCatalogWrite
} from './catalogWrites'
import { catalogVersion, reloadCatalog, stillCurrentProject } from './catalogSession'
import type { CatalogFolderId } from './inputCatalog.types'
import { isForbiddenFolderCopyTarget } from './inputCatalogTree'

export type CatalogClipboard =
  | {
      projectId: string
      mode: 'copy'
      kind: 'file'
      sourceId: string
    }
  | {
      projectId: string
      mode: 'copy'
      kind: 'folder'
      folderId: string
    }
  | {
      projectId: string
      mode: 'cut'
      kind: 'file'
      sourceId: string
      expectedParentFolderId: CatalogFolderId
    }

/** 工程内会话剪贴板。不保存正文或路径，切换工程时清空。 */
export function useCatalogClipboard(
  projectId: string,
  folders: readonly ProjectFolderVO[],
  sources: readonly ProjectInputSourceSummaryVO[]
): {
  clipboard: CatalogClipboard | null
  pasteBlocked: boolean
  copyFile: (sourceId: string) => void
  cutFile: (sourceId: string) => void
  copyFolder: (folderId: string) => void
  clearClipboard: () => void
  canPasteInto: (targetFolderId: CatalogFolderId) => boolean
  pasteInto: (
    client: ProjectFilesClient,
    queryClient: QueryClient,
    targetFolderId: CatalogFolderId,
    busy: boolean,
    setBusy: (value: boolean) => void
  ) => Promise<void>
} {
  const [clipboard, setClipboard] = useState<CatalogClipboard | null>(null)
  const [pasteBlocked, setPasteBlocked] = useState(false)

  useEffect(() => {
    setClipboard(null)
    setPasteBlocked(false)
  }, [projectId])

  useEffect(() => {
    if (!clipboard || clipboard.projectId !== projectId) return
    const exists =
      clipboard.kind === 'file'
        ? sources.some((source) => source.sourceId === clipboard.sourceId)
        : folders.some((folder) => folder.folderId === clipboard.folderId)
    if (exists || catalogWriteBlockedFor(projectId)) return
    setClipboard(null)
    setPasteBlocked(false)
    toast(workbenchFeedback.clipboardCleared)
  }, [clipboard, folders, projectId, sources])

  const copyFile = useCallback(
    (sourceId: string) => {
      if (catalogWriteBlockedFor(projectId) || projectId.length === 0) return
      setClipboard({ projectId, mode: 'copy', kind: 'file', sourceId })
      setPasteBlocked(false)
      toast(workbenchFeedback.copiedFile)
    },
    [projectId]
  )

  const cutFile = useCallback(
    (sourceId: string) => {
      if (catalogWriteBlockedFor(projectId) || projectId.length === 0) return
      const source = sources.find((item) => item.sourceId === sourceId)
      if (!source) return
      setClipboard({
        projectId,
        mode: 'cut',
        kind: 'file',
        sourceId,
        expectedParentFolderId: source.parentFolderId
      })
      setPasteBlocked(false)
      toast(workbenchFeedback.cutFile)
    },
    [projectId, sources]
  )

  const copyFolder = useCallback(
    (folderId: string) => {
      if (catalogWriteBlockedFor(projectId) || projectId.length === 0) return
      setClipboard({ projectId, mode: 'copy', kind: 'folder', folderId })
      setPasteBlocked(false)
      toast(workbenchFeedback.copiedFolder)
    },
    [projectId]
  )

  const clearClipboard = useCallback(() => {
    if (catalogWriteBlockedFor(projectId)) return
    setClipboard(null)
    setPasteBlocked(false)
  }, [])

  const canPasteInto = useCallback(
    (targetFolderId: CatalogFolderId): boolean => {
      if (!clipboard || pasteBlocked || clipboard.projectId !== projectId) return false
      if (clipboard.kind !== 'folder') return true
      return !isForbiddenFolderCopyTarget(folders, clipboard.folderId, targetFolderId)
    },
    [clipboard, folders, pasteBlocked, projectId]
  )

  return {
    clipboard,
    pasteBlocked,
    copyFile,
    cutFile,
    copyFolder,
    clearClipboard,
    canPasteInto,
    pasteInto: async (client, queryClient, targetFolderId, busy, setBusy) => {
      if (catalogWriteBlockedFor(projectId)) return
      if (!clipboard || pasteBlocked || clipboard.projectId !== projectId) return
      if (!canPasteInto(targetFolderId)) return
      if (!beginCatalogWrite(projectId, busy, setBusy)) return
      const operationId = crypto.randomUUID()
      try {
        const expectedCatalogVersion = catalogVersion(queryClient, projectId)
        if (clipboard.kind === 'file' && clipboard.mode === 'copy') {
          requireSuccess(
            await client.copyProjectFile({
              projectId,
              operationId,
              sourceId: clipboard.sourceId,
              targetFolderId,
              expectedCatalogVersion
            })
          )
          if (stillCurrentProject(projectId)) toast(workbenchFeedback.pastedCopy)
        } else if (clipboard.kind === 'folder') {
          requireSuccess(
            await client.copyProjectFolder({
              projectId,
              operationId,
              folderId: clipboard.folderId,
              targetFolderId,
              expectedCatalogVersion
            })
          )
          if (stillCurrentProject(projectId)) toast(workbenchFeedback.pastedCopy)
        } else {
          requireSuccess(
            await client.moveProjectFile({
              projectId,
              operationId,
              sourceId: clipboard.sourceId,
              expectedParentFolderId: clipboard.expectedParentFolderId,
              targetFolderId,
              expectedCatalogVersion
            })
          )
          if (stillCurrentProject(projectId)) {
            setClipboard(null)
            toast(workbenchFeedback.pastedMove)
          }
        }
      } catch (error) {
        if (!stillCurrentProject(projectId)) return
        const failure = failureOf(error)
        toast(failure.msg)
        if (failure.code === COMMIT_UNCLEAR_CODE) {
          setPasteBlocked(true)
          holdUnresolvedCatalogWrite(projectId, operationId)
        }
      } finally {
        if (stillCurrentProject(projectId)) await reloadCatalog(client, queryClient, projectId)
        endCatalogWrite(projectId, setBusy)
      }
    }
  }
}
