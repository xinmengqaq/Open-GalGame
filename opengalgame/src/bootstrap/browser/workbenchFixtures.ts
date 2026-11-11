import type { ProjectFilesInspectionVO } from '@application/project-files/vo/ProjectFilesInspectionVO'
import type { ProjectFolderVO } from '@application/project-files/vo/ProjectInputCatalogVO'
import type {
  ProjectInputSourceSummaryVO,
  ProjectInputSourceVO
} from '@application/project-files/vo/ProjectInputSourceVO'
import type { SceneCanvasArrangementVO } from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'

export type WorkbenchFixtureMode = 'mixed' | 'empty' | 'fail' | 'damaged'

export function readWorkbenchFixtureMode(): WorkbenchFixtureMode {
  const value = new URLSearchParams(window.location.search).get('workbench')
  if (value === 'empty' || value === 'fail' || value === 'damaged') return value
  return 'mixed'
}

export const workbenchSourceSummaries: readonly ProjectInputSourceSummaryVO[] = [
  {
    sourceId: 'doc-role',
    name: '角色与场景',
    readable: true,
    parentFolderId: 'folder-ref',
    contentKind: 'text',
    textKind: 'document'
  },
  {
    sourceId: 'bg-sora',
    name: '工坊屋顶.png',
    readable: true,
    parentFolderId: 'folder-scene',
    contentKind: 'image'
  },
  {
    sourceId: 'cg-moon',
    name: '月下对白.png',
    readable: true,
    parentFolderId: 'folder-scene',
    contentKind: 'image'
  },
  {
    sourceId: 'fig-hero',
    name: '女主立绘.png',
    readable: true,
    parentFolderId: 'folder-cast',
    contentKind: 'image'
  },
  {
    sourceId: 'avatar-hero',
    name: '女主头像.png',
    readable: true,
    parentFolderId: 'folder-cast',
    contentKind: 'image'
  },
  {
    sourceId: 'bgm-night',
    name: '夜色主题.wav',
    readable: true,
    parentFolderId: null,
    contentKind: 'audio'
  },
  {
    sourceId: 'sfx-page',
    name: '翻页.wav',
    readable: true,
    parentFolderId: null,
    contentKind: 'audio'
  },
  {
    sourceId: 'voice-line',
    name: '开场配音.ogg',
    readable: true,
    parentFolderId: 'folder-cast',
    contentKind: 'audio'
  },
  {
    sourceId: 'video-op',
    name: '开场影像.mp4',
    readable: true,
    parentFolderId: null,
    contentKind: 'video'
  },
  {
    sourceId: 'broken-bg',
    name: '损坏背景.png',
    readable: false,
    parentFolderId: 'folder-scene',
    contentKind: 'image'
  }
]

export const workbenchSourceFolders: readonly ProjectFolderVO[] = [
  { folderId: 'folder-ref', parentFolderId: null, name: '参考资料' },
  { folderId: 'folder-scene', parentFolderId: null, name: '场景背景' },
  { folderId: 'folder-cast', parentFolderId: 'folder-ref', name: '角色立绘' }
]

export const workbenchSourceDetails: Record<string, ProjectInputSourceVO> = {
  'doc-role': {
    sourceId: 'doc-role',
    version: 'v1',
    contentKind: 'text',
    textKind: 'document',
    title: '角色与场景',
    body: '# 角色与场景\n\n女主站在工坊屋顶。\n\n- 性格：认真\n- 地点：月光工坊\n\n> 下一句，你来写。',
    topics: ['角色', '地点'],
    importInfo: { format: 'markdown' }
  },
  'bg-sora': {
    sourceId: 'bg-sora',
    version: 'v1',
    contentKind: 'image',
    name: '工坊屋顶',
    fileId: 'file-bg-sora',
    description: '黄昏的瓦顶与远处灯火。'
  },
  'cg-moon': {
    sourceId: 'cg-moon',
    version: 'v1',
    contentKind: 'image',
    name: '月下对白',
    fileId: 'file-cg-moon',
    description: '事件插画。'
  },
  'fig-hero': {
    sourceId: 'fig-hero',
    version: 'v1',
    contentKind: 'image',
    name: '女主立绘',
    fileId: 'file-fig-hero',
    description: '默认表情。'
  },
  'avatar-hero': {
    sourceId: 'avatar-hero',
    version: 'v1',
    contentKind: 'image',
    name: '女主头像',
    fileId: 'file-avatar-hero',
    description: '对话框头像。'
  },
  'bgm-night': {
    sourceId: 'bgm-night',
    version: 'v1',
    contentKind: 'audio',
    name: '夜色主题',
    fileId: 'file-bgm-night',
    description: '缓慢的夜间氛围。'
  },
  'sfx-page': {
    sourceId: 'sfx-page',
    version: 'v1',
    contentKind: 'audio',
    name: '翻页',
    fileId: 'file-sfx-page',
    description: '短促纸声。'
  },
  'voice-line': {
    sourceId: 'voice-line',
    version: 'v1',
    contentKind: 'audio',
    name: '开场配音',
    fileId: 'file-voice-line',
    description: '未绑定台词。'
  },
  'video-op': {
    sourceId: 'video-op',
    version: 'v1',
    contentKind: 'video',
    name: '开场影像',
    fileId: 'file-video-op',
    description: '开场镜头。'
  }
}

/** 只读 v4 编排夹具。每类卡片至少一张，关系一条有名有记录、一条未写关系。 */
function mixedArrangement(projectId: string): SceneCanvasArrangementVO {
  return {
    projectId,
    sceneId: 'scene-1',
    canvasId: 'canvas-1',
    viewport: { x: 0, y: 0, zoom: 0.85 },
    cards: [
      {
        kind: 'document',
        cardId: 'card-doc',
        sourceId: 'doc-role',
        title: '角色与场景',
        summary: '角色、地点',
        layout: { x: 32, y: 48, width: 300, height: 224 }
      },
      {
        kind: 'image',
        cardId: 'card-bg',
        sourceId: 'bg-sora',
        role: 'background',
        title: '工坊屋顶',
        summary: '',
        layout: { x: 372, y: 32, width: 320, height: 208 }
      },
      {
        kind: 'video',
        cardId: 'card-video',
        sourceId: 'video-op',
        title: '开场影像',
        summary: '',
        layout: { x: 732, y: 32, width: 320, height: 200 }
      },
      {
        kind: 'prompt',
        cardId: 'card-prompt',
        body: '用克制的对白写出屋顶上的第一句。',
        references: [],
        layout: { x: 32, y: 312, width: 320, height: 252 }
      },
      {
        kind: 'audio',
        cardId: 'card-audio',
        sourceId: 'bgm-night',
        role: 'music',
        title: '夜色主题',
        summary: '缓慢的夜间氛围。',
        layout: { x: 392, y: 286, width: 300, height: 176 }
      },
      {
        kind: 'animation',
        cardId: 'card-anim',
        webgalPreset: { command: 'setAnimation', name: 'enter-from-left' },
        layout: { x: 732, y: 276, width: 296, height: 188 }
      },
      {
        kind: 'effect',
        cardId: 'card-fx',
        webgalPreset: null,
        layout: { x: 732, y: 520, width: 296, height: 188 }
      },
      {
        kind: 'document',
        cardId: 'card-missing',
        sourceId: 'gone-source',
        title: '缺失文档',
        summary: '',
        layout: { x: 32, y: 592, width: 300, height: 200 }
      }
    ],
    relations: [
      {
        relationId: 'rel-doc-bg',
        fromCardId: 'card-doc',
        toCardId: 'card-bg',
        specificName: '同一场景',
        recordCardId: 'card-doc'
      },
      {
        relationId: 'rel-prompt-audio',
        fromCardId: 'card-prompt',
        toCardId: 'card-audio',
        specificName: '',
        recordCardId: null
      }
    ]
  }
}

export function fixtureReadSources(
  projectId: string,
  sourceIds: readonly string[]
): AjaxResult<{ projectId: string; readVersion: string; sources: ProjectInputSourceVO[] }> {
  if (readWorkbenchFixtureMode() === 'fail') {
    return { code: ErrorCodes.communicationFailed, msg: '当前环境不能读取工程文件' }
  }
  const sources = sourceIds
    .map((id) => workbenchSourceDetails[id])
    .filter((item): item is ProjectInputSourceVO => Boolean(item))
  if (sources.length !== sourceIds.length) {
    return { code: 4313, msg: '来源不存在' }
  }
  return {
    code: ErrorCodes.success,
    msg: '来源读取成功',
    data: { projectId, readVersion: 'read-v1', sources }
  }
}

/** 浏览器只读编排夹具。没有保存文件返回 null；损坏和读取失败分别返回。 */
export function fixtureReadArrangement(
  projectId: string
): AjaxResult<SceneCanvasArrangementVO | null> {
  const mode = readWorkbenchFixtureMode()
  if (mode === 'fail') {
    return { code: ErrorCodes.communicationFailed, msg: '当前环境不能读取工程文件' }
  }
  if (mode === 'damaged') {
    return { code: 4416, msg: '编排内容损坏' }
  }
  if (mode === 'empty') {
    return { code: ErrorCodes.success, msg: '没有已保存编排', data: null }
  }
  return { code: ErrorCodes.success, msg: '编排读取成功', data: mixedArrangement(projectId) }
}

export function fixtureInspect(projectId: string): AjaxResult<ProjectFilesInspectionVO> {
  if (readWorkbenchFixtureMode() === 'fail') {
    return { code: ErrorCodes.communicationFailed, msg: '当前环境不能读取工程文件' }
  }
  return {
    code: ErrorCodes.success,
    msg: '检查完成',
    data: {
      projectId,
      inputSourceFormatSupported: true,
      canvasArrangementFormatSupported: true,
      diagnostics:
        readWorkbenchFixtureMode() === 'mixed'
          ? [
              { objectId: 'broken-bg', kind: 'damaged' },
              { objectId: 'gone-source', kind: 'brokenReference' }
            ]
          : []
    }
  }
}
