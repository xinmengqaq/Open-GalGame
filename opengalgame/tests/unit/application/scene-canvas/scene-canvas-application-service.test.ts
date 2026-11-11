import { describe, expect, it } from 'vitest'

import type { ProjectFilesApplicationService } from '@application/project-files/services/ProjectFilesApplicationService'
import type { ProjectInputSourceVO } from '@application/project-files/vo/ProjectInputSourceVO'
import { SceneCanvasApplicationServiceImpl } from '@application/scene-canvas/services/impl/SceneCanvasApplicationServiceImpl'
import type {
  SceneCanvasVersionKeepRequest,
  SceneCanvasVersionSettlement
} from '@application/scene-canvas/models/SceneCanvasSaveFacts'
import type { SceneCanvasArrangementPersistenceGateway } from '@application/scene-canvas/ports/SceneCanvasArrangementPersistenceGateway'
import type { SceneCanvasArrangementVO } from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import { AppException } from '@common/errors/AppException'
import { SceneCanvasErrorCodes } from '@domain/scene-canvas/errors/SceneCanvasErrorCodes'
import { ProjectErrorCodes } from '@domain/projects/errors/ProjectErrorCodes'

function arrangement(): SceneCanvasArrangementVO {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    canvasId: 'canvas-1',
    viewport: { x: 1, y: 2, zoom: 1 },
    cards: [
      {
        kind: 'document',
        cardId: 'doc',
        sourceId: 'source-doc',
        title: '设定',
        summary: '',
        layout: { x: 0, y: 0, width: 100, height: 80 }
      }
    ],
    relations: []
  }
}

function documentSource(): ProjectInputSourceVO {
  return {
    sourceId: 'source-doc',
    version: 'v1',
    contentKind: 'text',
    textKind: 'document',
    title: '角色设定',
    body: '不应进入卡片',
    topics: ['角色'],
    importInfo: { format: 'markdown' }
  }
}

function createService(options?: {
  source?: ProjectInputSourceVO | null
  sourceError?: AppException
  readError?: AppException
  writeError?: Error
  workspaceReady?: boolean
}): {
  service: SceneCanvasApplicationServiceImpl
  persistence: {
    current: SceneCanvasArrangementVO | null
    writes: SceneCanvasArrangementVO[]
    reads: string[]
  }
  versions: {
    keep: SceneCanvasVersionKeepRequest[]
    settlementReads: string[]
    settlement: SceneCanvasVersionSettlement
  }
} {
  const persistenceState = {
    current: null as SceneCanvasArrangementVO | null,
    writes: [] as SceneCanvasArrangementVO[],
    reads: [] as string[]
  }
  const persistence: SceneCanvasArrangementPersistenceGateway = {
    readArrangement: (projectId, sceneId, canvasId) => {
      persistenceState.reads.push(`${projectId}/${sceneId}/${canvasId}`)
      if (options?.readError) return Promise.reject(options.readError)
      return Promise.resolve(
        persistenceState.current === null ? null : structuredClone(persistenceState.current)
      )
    },
    writeArrangement: (value) => {
      if (options?.writeError) return Promise.reject(options.writeError)
      persistenceState.writes.push(structuredClone(value))
      persistenceState.current = structuredClone(value)
      return Promise.resolve()
    }
  }
  const versionState = {
    keep: [] as SceneCanvasVersionKeepRequest[],
    settlementReads: [] as string[],
    settlement: { state: 'kept' as const }
  }
  const versions: SceneCanvasWorkVersionGateway = {
    keepArrangement: (request) => {
      versionState.keep.push(structuredClone(request))
      return Promise.resolve(versionState.settlement)
    },
    readSettlement: (operationId) => {
      versionState.settlementReads.push(operationId)
      return Promise.resolve(versionState.settlement)
    }
  }
  const sources: Pick<ProjectFilesApplicationService, 'readProjectInputSources'> = {
    readProjectInputSources: () => {
      if (options?.sourceError) return Promise.reject(options.sourceError)
      if (options?.source === null) {
        return Promise.resolve({ projectId: 'project-1', readVersion: 'r1', sources: [] })
      }
      return Promise.resolve({
        projectId: 'project-1',
        readVersion: 'r1',
        sources: [options?.source ?? documentSource()]
      })
    }
  }
  let sequence = 0
  return {
    service: new SceneCanvasApplicationServiceImpl({
      sources,
      persistence,
      versions,
      workspace: {
        inspectProjectWorkspace: async () => ({
          ready: options?.workspaceReady !== false,
          sceneId: 'scene-1',
          canvasId: 'canvas-1'
        })
      },
      nextId: () => `id-${++sequence}`
    }),
    persistence: persistenceState,
    versions: versionState
  }
}

describe('场景画布应用编排', () => {
  it('编辑调用领域规则并返回不含用途的编排', async () => {
    const { service } = createService()
    const next = await service.editCard({
      ...arrangement(),
      arrangement: arrangement(),
      cardId: 'doc',
      title: '  新标题  '
    })
    expect(next.cards[0]).toEqual({
      kind: 'document',
      cardId: 'doc',
      sourceId: 'source-doc',
      title: '新标题',
      summary: '',
      layout: { x: 0, y: 0, width: 100, height: 80 }
    })
    expect(next).not.toHaveProperty('version')
  })

  it('来源建卡只取标题，不复制正文', async () => {
    const { service } = createService()
    const next = await service.createSourceCard({
      ...arrangement(),
      arrangement: arrangement(),
      sourceId: 'source-doc',
      layout: { x: 8, y: 9, width: 120, height: 80 }
    })
    expect(next.cards[1]).toEqual({
      kind: 'document',
      cardId: 'id-1',
      sourceId: 'source-doc',
      title: '角色设定',
      summary: '',
      layout: { x: 8, y: 9, width: 120, height: 80 }
    })
    expect(JSON.stringify(next)).not.toContain('不应进入卡片')
  })

  it('图片和视频说明可编辑，来源建卡带入 description', async () => {
    const image: SceneCanvasArrangementVO = {
      ...arrangement(),
      cards: [
        {
          kind: 'image',
          cardId: 'image',
          sourceId: 'source-image',
          role: 'background',
          title: '屋顶',
          summary: '',
          layout: { x: 0, y: 0, width: 100, height: 80 }
        },
        {
          kind: 'video',
          cardId: 'video',
          sourceId: 'source-video',
          title: '开场',
          summary: '旧说明',
          layout: { x: 120, y: 0, width: 100, height: 80 }
        }
      ]
    }
    const edited = await createService().service.editCard({
      ...image,
      arrangement: image,
      cardId: 'image',
      summary: '  屋顶夜景  '
    })
    expect(edited.cards[0]).toMatchObject({ kind: 'image', summary: '  屋顶夜景  ' })
    const cleared = await createService().service.editCard({
      ...image,
      arrangement: image,
      cardId: 'video',
      summary: ''
    })
    expect(cleared.cards[1]).toMatchObject({ kind: 'video', summary: '' })

    const created = await createService({
      source: {
        sourceId: 'source-image',
        version: 'v1',
        contentKind: 'image',
        name: '屋顶.png',
        fileId: 'file-image',
        description: '来源用途'
      }
    }).service.createSourceCard({
      ...arrangement(),
      arrangement: arrangement(),
      sourceId: 'source-image',
      layout: { x: 8, y: 9, width: 120, height: 80 }
    })
    expect(created.cards[1]).toMatchObject({
      kind: 'image',
      title: '屋顶.png',
      summary: '来源用途',
      role: 'background'
    })
    const video = await createService({
      source: {
        sourceId: 'source-video',
        version: 'v1',
        contentKind: 'video',
        name: '开场.mp4',
        fileId: 'file-video',
        description: ''
      }
    }).service.createSourceCard({
      ...arrangement(),
      arrangement: arrangement(),
      sourceId: 'source-video',
      layout: { x: 8, y: 9, width: 120, height: 80 }
    })
    expect(video.cards[1]).toMatchObject({ kind: 'video', title: '开场.mp4', summary: '' })
  })

  it('来源不可读时拒绝建卡', async () => {
    const { service } = createService({ source: null })
    await expect(
      service.createSourceCard({
        ...arrangement(),
        arrangement: arrangement(),
        sourceId: 'missing',
        layout: { x: 0, y: 0, width: 10, height: 10 }
      })
    ).rejects.toMatchObject({ code: SceneCanvasErrorCodes.sourceUnreadable })
  })

  it('没有保存文件返回 null，损坏继续失败', async () => {
    const { service, persistence } = createService()
    await expect(
      service.readSceneCanvasArrangement({
        projectId: 'project-1',
        sceneId: 'scene-1',
        canvasId: 'canvas-1'
      })
    ).resolves.toBeNull()
    persistence.current = arrangement()
    await expect(
      service.readSceneCanvasArrangement({
        projectId: 'project-1',
        sceneId: 'scene-1',
        canvasId: 'canvas-1'
      })
    ).resolves.toEqual(arrangement())
    const damaged = createService({
      readError: new AppException({
        code: SceneCanvasErrorCodes.contentDamaged,
        msg: '编排内容损坏'
      })
    })
    await expect(
      damaged.service.readSceneCanvasArrangement({
        projectId: 'project-1',
        sceneId: 'scene-1',
        canvasId: 'canvas-1'
      })
    ).rejects.toMatchObject({ code: SceneCanvasErrorCodes.contentDamaged })
  })

  it('保存先校验，内容相同仍确认版本，且只处理当前画布', async () => {
    const { service, persistence, versions } = createService()
    persistence.current = arrangement()
    await service.saveSceneCanvasArrangement({
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      reason: 'periodic',
      arrangement: arrangement()
    })
    expect(persistence.writes).toEqual([])
    expect(persistence.reads).toEqual(['project-1/scene-1/canvas-1'])
    expect(versions.keep[0]).toMatchObject({
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      reason: 'periodic',
      arrangement: arrangement()
    })
  })

  it('工作区未就绪时不落盘也不提交', async () => {
    const { service, persistence, versions } = createService({ workspaceReady: false })
    const draft = arrangement()
    draft.viewport = { x: 3, y: 4, zoom: 1 }
    await expect(
      service.saveSceneCanvasArrangement({
        projectId: 'project-1',
        sceneId: 'scene-1',
        canvasId: 'canvas-1',
        reason: 'manual',
        arrangement: draft
      })
    ).rejects.toMatchObject({
      code: ProjectErrorCodes.workspaceNotReady,
      message: '工程初始化未完成，请重新构建'
    })
    expect(persistence.writes).toEqual([])
    expect(versions.keep).toEqual([])
  })

  it('落盘失败不请求版本确认', async () => {
    const { service, versions } = createService({ writeError: new Error('disk') })
    const draft = arrangement()
    draft.viewport = { x: 3, y: 4, zoom: 1 }
    await expect(
      service.saveSceneCanvasArrangement({
        projectId: 'project-1',
        sceneId: 'scene-1',
        canvasId: 'canvas-1',
        reason: 'manual',
        arrangement: draft
      })
    ).rejects.toMatchObject({ code: SceneCanvasErrorCodes.persistFailed })
    expect(versions.keep).toEqual([])
  })

  it('版本确定失败和结果不明分别抛出，不明时下次先核对', async () => {
    const failed = createService()
    failed.versions.settlement = { state: 'failed' }
    const changed = arrangement()
    changed.viewport = { x: 9, y: 0, zoom: 1 }
    await expect(
      failed.service.saveSceneCanvasArrangement({
        projectId: 'project-1',
        sceneId: 'scene-1',
        canvasId: 'canvas-1',
        reason: 'manual',
        arrangement: changed
      })
    ).rejects.toMatchObject({ code: SceneCanvasErrorCodes.commitFailed })

    const unclear = createService()
    unclear.versions.settlement = { state: 'unknown' }
    await expect(
      unclear.service.saveSceneCanvasArrangement({
        projectId: 'project-1',
        sceneId: 'scene-1',
        canvasId: 'canvas-1',
        reason: 'beforeGeneration',
        arrangement: changed
      })
    ).rejects.toMatchObject({ code: SceneCanvasErrorCodes.commitUnknown })
    unclear.persistence.writes = []
    unclear.versions.keep = []
    await expect(
      unclear.service.saveSceneCanvasArrangement({
        projectId: 'project-1',
        sceneId: 'scene-1',
        canvasId: 'canvas-1',
        reason: 'periodic',
        arrangement: changed
      })
    ).rejects.toMatchObject({ code: SceneCanvasErrorCodes.commitUnknown })
    expect(unclear.persistence.writes).toEqual([])
    expect(unclear.versions.keep).toEqual([])
    expect(unclear.versions.settlementReads).toEqual(['id-1'])
  })

  it('生成前保存固定当时快照，后续编辑不改变本次请求', async () => {
    const { service, persistence, versions } = createService()
    const snapshot = arrangement()
    snapshot.viewport = { x: 5, y: 6, zoom: 1.5 }
    const pending = service.saveSceneCanvasArrangement({
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      reason: 'beforeGeneration',
      arrangement: snapshot
    })
    snapshot.viewport.zoom = 9
    snapshot.cards[0] = { ...snapshot.cards[0]!, title: '后来改的' }
    await pending
    expect(persistence.writes[0]?.viewport.zoom).toBe(1.5)
    expect(versions.keep[0]?.arrangement.cards[0]).toMatchObject({ title: '设定' })
    expect(versions.keep[0]?.reason).toBe('beforeGeneration')
  })

  it('非法草稿不调用持久化端口', async () => {
    const { service, persistence } = createService()
    const draft = arrangement()
    draft.cards = [{ ...draft.cards[0]!, title: ' ' }]
    await expect(
      service.editCard({ ...draft, arrangement: draft, cardId: 'doc', title: ' ' })
    ).rejects.toBeInstanceOf(AppException)
    expect(persistence.reads).toEqual([])
  })
})
