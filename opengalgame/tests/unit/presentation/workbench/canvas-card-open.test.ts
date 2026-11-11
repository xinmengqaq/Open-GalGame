import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

import type { AjaxResult } from '@common/contracts/AjaxResult'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import {
  canvasCardOpenAction,
  openCanvasSourceFile
} from '@presentation/features/scene-canvas/openCanvasCard'
import { useWorkbenchSessionStore } from '@presentation/features/workbench-session/workbenchSession.store'
import type { SessionCard } from '@presentation/features/workbench-session/workbenchSession.types'

vi.mock('sonner', () => ({
  toast: vi.fn()
}))

function card(kind: SessionCard['kind'], sourceId = `${kind}-source`): SessionCard {
  const layout = { x: 0, y: 0, width: 240, height: 160 }
  if (kind === 'prompt') return { kind, cardId: kind, body: '正文', layout }
  if (kind === 'animation' || kind === 'effect') {
    return { kind, cardId: kind, webgalPreset: null, layout }
  }
  if (kind === 'document' || kind === 'image' || kind === 'audio' || kind === 'video') {
    return {
      kind,
      cardId: kind,
      sourceId,
      title: '标题',
      summary: '',
      ...(kind === 'image' ? { role: 'background' as const } : {}),
      ...(kind === 'audio' ? { role: 'music' as const } : {}),
      layout
    }
  }
  return { kind, cardId: kind, sourceId, title: '标题', layout }
}

describe('画布卡片双击打开', () => {
  beforeEach(() => {
    vi.mocked(toast).mockReset()
    useWorkbenchSessionStore.getState().reset()
    useWorkbenchSessionStore.getState().startSession({
      projectId: 'p-01',
      projectName: '未寄出的第二封信',
      sceneId: 'scene-1',
      canvasId: 'canvas-1'
    })
    useWorkbenchSessionStore.getState().setCatalog([
      {
        sourceId: 'document-source',
        name: '角色设定.txt',
        readable: true,
        parentFolderId: null,
        contentKind: 'text',
        textKind: 'document'
      },
      {
        sourceId: 'image-source',
        name: '屋顶.png',
        readable: true,
        parentFolderId: null,
        contentKind: 'image'
      },
      {
        sourceId: 'audio-source',
        name: '雨声.wav',
        readable: true,
        parentFolderId: null,
        contentKind: 'audio'
      },
      {
        sourceId: 'video-source',
        name: '开场.mp4',
        readable: true,
        parentFolderId: null,
        contentKind: 'video'
      },
      {
        sourceId: 'unreadable-source',
        name: '损坏.png',
        readable: false,
        parentFolderId: null,
        contentKind: 'image'
      }
    ])
  })

  it('文档打开内置文档层，图片音频视频按当前工程来源打开系统文件', () => {
    expect(canvasCardOpenAction(card('document'), null, false)).toEqual({
      kind: 'document',
      cardId: 'document'
    })
    for (const kind of ['image', 'audio', 'video'] as const) {
      expect(canvasCardOpenAction(card(kind), null, false)).toEqual({
        kind: 'file',
        request: { projectId: 'p-01', sourceId: `${kind}-source` }
      })
    }
  })

  it('提示词、动画、特效、连接中和失效来源都不打开', () => {
    expect(canvasCardOpenAction(card('prompt'), null, false)).toBeNull()
    expect(canvasCardOpenAction(card('animation'), null, false)).toBeNull()
    expect(canvasCardOpenAction(card('effect'), null, false)).toBeNull()
    expect(canvasCardOpenAction(card('audio'), null, true)).toBeNull()
    expect(canvasCardOpenAction(card('image', 'missing-source'), null, false)).toBeNull()
    expect(canvasCardOpenAction(card('audio', 'unreadable-source'), null, false)).toBeNull()
    expect(canvasCardOpenAction(card('document', 'missing-source'), null, false)).toBeNull()
  })

  it('系统打开失败只提示安全说明，工程切换后的迟到失败不进入新会话', async () => {
    const openProjectFile = vi.fn(async (): Promise<AjaxResult<null>> => ({
      code: ErrorCodes.internalError,
      msg: '系统无法打开该文件'
    }))
    const client = { openProjectFile } as unknown as ProjectFilesClient
    await openCanvasSourceFile(client, { projectId: 'p-01', sourceId: 'image-source' })
    expect(openProjectFile).toHaveBeenCalledTimes(1)
    expect(openProjectFile).toHaveBeenCalledWith({ projectId: 'p-01', sourceId: 'image-source' })
    expect(toast).toHaveBeenCalledWith('系统无法打开该文件')

    vi.mocked(toast).mockClear()
    openProjectFile.mockRejectedValueOnce(
      new AppException({
        code: ErrorCodes.internalError,
        msg: 'D:\\secret\\project\\assets\\image-source\\屋顶.png 不存在'
      })
    )
    useWorkbenchSessionStore.getState().startSession({
      projectId: 'p-02',
      projectName: '另一封信',
      sceneId: 'scene-1',
      canvasId: 'canvas-1'
    })
    await openCanvasSourceFile(client, { projectId: 'p-01', sourceId: 'image-source' })
    expect(toast).not.toHaveBeenCalled()
  })
})
