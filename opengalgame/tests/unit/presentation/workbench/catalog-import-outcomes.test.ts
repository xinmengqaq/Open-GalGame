import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ProjectInputSourceSummaryVO,
  ProjectFileAssetKind
} from '@application/project-files/vo/ProjectInputSourceVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import {
  COMMIT_UNCLEAR_CODE,
  COMMUNICATION_FAILED_CODE
} from '@presentation/feedback/projectFilesFeedback'
import {
  catalogProjectNeedsRecovery,
  chooseAndImport,
  endCatalogWrite
} from '@presentation/features/input-catalog/catalogWrites'
import type {
  CatalogImportOptions,
  CatalogImportOutcome
} from '@presentation/features/input-catalog/inputCatalog.types'
import type { ImportedSourceAction } from '@presentation/features/workbench-session/workbenchActionObservers'
import { useWorkbenchSessionStore } from '@presentation/features/workbench-session/workbenchSession.store'

vi.mock('sonner', () => ({ toast: vi.fn() }))

function ok<T>(data: T): AjaxResult<T> {
  return { code: ErrorCodes.success, msg: 'ok', data }
}

function summary(
  sourceId: string,
  contentKind: 'text' | ProjectFileAssetKind
): ProjectInputSourceSummaryVO {
  if (contentKind === 'text') {
    return {
      sourceId,
      name: `${sourceId}.md`,
      readable: true,
      parentFolderId: null,
      contentKind: 'text',
      textKind: 'document'
    }
  }
  const extension = contentKind === 'image' ? 'png' : contentKind === 'audio' ? 'wav' : 'mp4'
  return {
    sourceId,
    name: `${sourceId}.${extension}`,
    readable: true,
    parentFolderId: null,
    contentKind
  }
}

function startProject(projectId: string): void {
  useWorkbenchSessionStore.getState().reset()
  useWorkbenchSessionStore.getState().startSession({
    projectId,
    projectName: projectId,
    sceneId: 'scene-1',
    canvasId: 'canvas-1'
  })
}

async function choose(
  client: ProjectFilesClient,
  projectId: string,
  options?: {
    mediaKinds?: readonly ProjectFileAssetKind[]
    onImported?: (sources: readonly ImportedSourceAction[]) => void
  }
): Promise<CatalogImportOutcome> {
  const importOptions: CatalogImportOptions | undefined = options?.mediaKinds
    ? { mediaKinds: options.mediaKinds }
    : undefined
  return chooseAndImport(
    client,
    new QueryClient(),
    projectId,
    null,
    false,
    () => undefined,
    options?.onImported,
    importOptions
  )
}

afterEach(() => {
  useWorkbenchSessionStore.getState().reset()
  endCatalogWrite('', () => undefined)
})

describe('目录导入：选择失败与写入不明分开', () => {
  it('选择器通信失败只算选择失败，不进入待核对，也不阻止立即重选', async () => {
    const projectId = 'project-chooser-failure'
    startProject(projectId)
    const importProjectFiles = vi.fn()
    const failing = {
      chooseProjectFiles: async () => ({
        code: COMMUNICATION_FAILED_CODE,
        msg: '与主进程通信失败，操作结果待确认',
        data: null
      }),
      importProjectFiles
    } as unknown as ProjectFilesClient

    await expect(choose(failing, projectId)).resolves.toEqual({ status: 'failed' })
    expect(importProjectFiles).not.toHaveBeenCalled()
    expect(catalogProjectNeedsRecovery(projectId)).toBe(false)

    const retryChooser = vi.fn(async () => ok(null))
    const retry = await choose(
      { chooseProjectFiles: retryChooser } as unknown as ProjectFilesClient,
      projectId
    )
    expect(retry).toEqual({ status: 'cancelled' })
    expect(retryChooser).toHaveBeenCalledTimes(1)
  })

  it('选择器直接抛通信异常同样只算选择失败', async () => {
    const projectId = 'project-chooser-throw'
    startProject(projectId)
    const failing = {
      chooseProjectFiles: async () => {
        throw new AppException({
          code: COMMUNICATION_FAILED_CODE,
          msg: '暂存文件失败，操作结果待确认'
        })
      }
    } as unknown as ProjectFilesClient

    await expect(choose(failing, projectId)).resolves.toEqual({ status: 'failed' })
    expect(catalogProjectNeedsRecovery(projectId)).toBe(false)
  })

  it('正常导入仍只按服务端已导入来源发布事实', async () => {
    const projectId = 'project-import-success'
    startProject(projectId)
    const imported: ImportedSourceAction[] = []
    const client = {
      chooseProjectFiles: async () => ok(['C:/tmp/剧本.md']),
      importProjectFiles: async () =>
        ok({ importedFiles: [summary('src-doc', 'text')], failedFiles: [] })
    } as unknown as ProjectFilesClient

    await expect(choose(client, projectId, { onImported: (sources) => imported.push(...sources) }))
      .resolves.toEqual({
        status: 'imported',
        sources: [
          { projectId, sourceId: 'src-doc', contentKind: 'text', candidateKind: null }
        ]
      })
    expect(imported).toEqual([
      { projectId, sourceId: 'src-doc', contentKind: 'text', candidateKind: null }
    ])
  })
})

describe('目录导入：恢复不按目录差集宣告本次目标类别', () => {
  it('恢复确认提交也只重载目录，不把另一操作新增的来源当成本次成功', async () => {
    const projectId = 'project-recovery-no-diff'
    startProject(projectId)
    const oldSource = summary('src-old', 'image')
    useWorkbenchSessionStore.getState().setCatalog([oldSource])
    const imported: ImportedSourceAction[] = []
    let reloaded = false
    const client = {
      chooseProjectFiles: async () => ok(['C:/tmp/新音效.wav']),
      importProjectFiles: async () => ({
        code: COMMIT_UNCLEAR_CODE,
        msg: '提交结果不明',
        data: null
      }),
      recoverProjectFileOperations: async (request: { operationIds: readonly string[] }) =>
        ok(
          request.operationIds.map((operationId) => ({
            operationId,
            state: 'committed' as const
          }))
        ),
      listProjectInputSources: async () => {
        reloaded = true
        return ok({
          projectId,
          catalogVersion: 'catalog-2',
          folders: [],
          sources: [
            oldSource,
            summary('src-other-operation', 'image'),
            summary('src-audio', 'audio')
          ]
        })
      }
    } as unknown as ProjectFilesClient

    await expect(
      choose(client, projectId, {
        mediaKinds: ['audio'],
        onImported: (sources) => imported.push(...sources)
      })
    ).resolves.toEqual({ status: 'unconfirmed' })

    expect(imported).toEqual([])
    expect(reloaded).toBe(true)
    expect(useWorkbenchSessionStore.getState().sources.map((source) => source.sourceId)).toEqual([
      'src-old',
      'src-other-operation',
      'src-audio'
    ])
  })
})
