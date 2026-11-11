import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

import type { ImportProjectFilesVO } from '@application/project-files/vo/ProjectInputSourceVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import { importDroppedFiles } from '@presentation/features/input-catalog/useInputCatalog'
import { useWorkbenchSessionStore } from '@presentation/features/workbench-session/workbenchSession.store'
import { workbenchFeedback } from '@presentation/feedback/workbenchFeedback'

vi.mock('sonner', () => ({
  toast: vi.fn()
}))

function ok<T>(data: T): AjaxResult<T> {
  return { code: ErrorCodes.success, msg: 'ok', data }
}

function fail(msg: string): AjaxResult<never> {
  return { code: ErrorCodes.internalError, msg }
}

function droppedFiles(...names: string[]): FileList {
  const files = names.map((name) => new File(['x'], name))
  Object.assign(files, {
    item: (index: number) => files[index] ?? null
  })
  return files as unknown as FileList
}

describe('外部文件拖入', () => {
  beforeEach(() => {
    vi.mocked(toast).mockReset()
    useWorkbenchSessionStore.getState().reset()
    useWorkbenchSessionStore.getState().startSession({
      projectId: 'p-01',
      projectName: '未寄出的第二封信',
      sceneId: 'scene-1',
      canvasId: 'canvas-1'
    })
  })

  it('部分路径转换失败时提示该文件，其余路径仍导入当前目录', async () => {
    const imported: ImportProjectFilesVO = {
      importedFiles: [
        {
          sourceId: 'a',
          name: 'ok-a.txt',
          readable: true,
          parentFolderId: 'folder-ref',
          contentKind: 'text',
          textKind: 'document'
        },
        {
          sourceId: 'c',
          name: 'ok-c.txt',
          readable: true,
          parentFolderId: 'folder-ref',
          contentKind: 'text',
          textKind: 'document'
        }
      ],
      failedFiles: []
    }
    const importProjectFiles = vi.fn(async () => ok(imported))
    const client = {
      pathForDroppedFile: async (file: File) =>
        file.name === 'bad.txt' ? fail('无法转换该文件') : ok(`/tmp/${file.name}`),
      importProjectFiles,
      listProjectInputSources: async () =>
        ok({
          projectId: 'p-01',
          catalogVersion: 'v2',
          folders: [],
          sources: imported.importedFiles
        })
    } as unknown as ProjectFilesClient
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    })
    queryClient.setQueryData(['project-input-sources', 'p-01'], {
      projectId: 'p-01',
      catalogVersion: 'v1',
      folders: [],
      sources: []
    })
    const setBusy = vi.fn()

    await importDroppedFiles(
      client,
      queryClient,
      'p-01',
      'folder-ref',
      droppedFiles('ok-a.txt', 'bad.txt', 'ok-c.txt'),
      false,
      setBusy
    )

    expect(toast).toHaveBeenCalledWith('无法转换该文件')
    expect(importProjectFiles).toHaveBeenCalledWith({
      projectId: 'p-01',
      localFilePaths: ['/tmp/ok-a.txt', '/tmp/ok-c.txt'],
      parentFolderId: 'folder-ref',
      expectedCatalogVersion: 'v1'
    })
    expect(toast).toHaveBeenCalledWith(workbenchFeedback.importImported(2))
  })

  it('全部路径转换失败时按文件提示，不调用导入', async () => {
    const importProjectFiles = vi.fn()
    const client = {
      pathForDroppedFile: async (file: File) => fail(`${file.name} 无法转换`),
      importProjectFiles
    } as unknown as ProjectFilesClient
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    })

    await importDroppedFiles(
      client,
      queryClient,
      'p-01',
      null,
      droppedFiles('a.txt', 'b.txt', 'c.txt'),
      false,
      vi.fn()
    )

    expect(toast).toHaveBeenCalledWith('a.txt 无法转换')
    expect(toast).toHaveBeenCalledWith('b.txt 无法转换')
    expect(toast).toHaveBeenCalledWith('c.txt 无法转换')
    expect(importProjectFiles).not.toHaveBeenCalled()
  })
})
