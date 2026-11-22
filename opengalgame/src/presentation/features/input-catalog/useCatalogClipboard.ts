import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import type { ProjectFolderVO } from '@application/project-files/vo/ProjectInputCatalogVO'
import type { ProjectInputSourceSummaryVO } from '@application/project-files/vo/ProjectInputSourceVO'
import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import type { QueryClient } from '@tanstack/react-query'
import { failureOf, requireSuccess } from '../../feedback/failure'
import { workbenchFeedback } from '../../feedback/workbenchFeedback'
import {
  beginCatalogWrite,
  endCatalogWrite,
  isUncertainCatalogWrite,
  resolveCatalogWrite
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

export function useCatalogClipboard(
  projectId: string,
  folders: readonly ProjectFolderVO[],
  sources: readonly ProjectInputSourceSummaryVO[]
): {
  clipboard: CatalogClipboard | null
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
  const [clearedClipboardCount, setClearedClipboardCount] = useState(0)
  const announcedClearCount = useRef(0)

  useEffect(() => {
    if (clearedClipboardCount === announcedClearCount.current) return
    announcedClearCount.current = clearedClipboardCount
    toast(workbenchFeedback.clipboardCleared)
  }, [clearedClipboardCount])

  const [renderedProjectId, setRenderedProjectId] = useState(projectId)
  if (renderedProjectId !== projectId) {
    setRenderedProjectId(projectId)
    setClipboard(null)
  }

  const clipboardIsStale =
    clipboard !== null &&
    clipboard.projectId === projectId &&
    !(clipboard.kind === 'file'
      ? sources.some((source) => source.sourceId === clipboard.sourceId)
      : folders.some((folder) => folder.folderId === clipboard.folderId))
  if (clipboardIsStale) {
    setClipboard(null)
    setClearedClipboardCount(clearedClipboardCount + 1)
  }

  const copyFile = useCallback(
    (sourceId: string) => {
      if (projectId.length === 0) return
      setClipboard({ projectId, mode: 'copy', kind: 'file', sourceId })
      toast(workbenchFeedback.copiedFile)
    },
    [projectId]
  )

  const cutFile = useCallback(
    (sourceId: string) => {
      if (projectId.length === 0) return
      const source = sources.find((item) => item.sourceId === sourceId)
      if (!source) return
      setClipboard({
        projectId,
        mode: 'cut',
        kind: 'file',
        sourceId,
        expectedParentFolderId: source.parentFolderId
      })
      toast(workbenchFeedback.cutFile)
    },
    [projectId, sources]
  )

  const copyFolder = useCallback(
    (folderId: string) => {
      if (projectId.length === 0) return
      setClipboard({ projectId, mode: 'copy', kind: 'folder', folderId })
      toast(workbenchFeedback.copiedFolder)
    },
    [projectId]
  )

  const clearClipboard = useCallback(() => {
    setClipboard(null)
  }, [])

  const canPasteInto = useCallback(
    (targetFolderId: CatalogFolderId): boolean => {
      if (!clipboard || clipboard.projectId !== projectId) return false
      if (clipboard.kind !== 'folder') return true
      return !isForbiddenFolderCopyTarget(folders, clipboard.folderId, targetFolderId)
    },
    [clipboard, folders, projectId]
  )

  return {
    clipboard,
    copyFile,
    cutFile,
    copyFolder,
    clearClipboard,
    canPasteInto,
    pasteInto: async (client, queryClient, targetFolderId, busy, setBusy) => {
      if (!clipboard || clipboard.projectId !== projectId) return
      if (!canPasteInto(targetFolderId)) return
      if (!beginCatalogWrite(projectId, busy, setBusy)) return
      const operationId = crypto.randomUUID()
      const applySuccess = (): void => {
        if (!stillCurrentProject(projectId)) return
        if (clipboard.kind === 'file' && clipboard.mode === 'cut') {
          setClipboard(null)
          toast(workbenchFeedback.pastedMove)
        } else {
          toast(workbenchFeedback.pastedCopy)
        }
      }
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
        }
        applySuccess()
      } catch (error) {
        const failure = failureOf(error)
        if (isUncertainCatalogWrite(failure)) {
          try {
            await resolveCatalogWrite(client, projectId, operationId)
          } catch (verifyError) {
            if (stillCurrentProject(projectId)) toast(failureOf(verifyError).msg)
            throw verifyError
          }
          applySuccess()
        } else if (stillCurrentProject(projectId)) {
          toast(failure.msg)
        }
      } finally {
        if (stillCurrentProject(projectId)) {
          await reloadCatalog(client, queryClient, projectId)
        }
        endCatalogWrite(projectId, setBusy)
      }
    }
  }
}
