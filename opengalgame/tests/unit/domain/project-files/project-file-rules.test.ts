import { describe, expect, it } from 'vitest'

import { AppException } from '@common/errors/AppException'
import {
  ProjectFileErrorCodes,
  type ProjectFileErrorCode
} from '@domain/project-files/errors/ProjectFileErrorCodes'
import type {
  SceneCanvasArrangement,
  SceneCanvasDocumentCard,
  SceneCanvasFieldCard,
  SceneCanvasPromptCard
} from '@domain/scene-canvas/models/SceneCanvasArrangement'
import type { ProjectFileInspectionFacts } from '@domain/project-files/models/ProjectFileDiagnostic'
import type {
  ProjectDocumentSource,
  ProjectFileAssetSource,
  ProjectInputSource
} from '@domain/project-files/models/ProjectInputSource'
import { inspectProjectFileFacts } from '@domain/project-files/services/inspectProjectFileFacts'

import { validateProjectInputSource } from '@domain/project-files/services/validateProjectInputSource'
import { validateProjectInputSources } from '@domain/project-files/services/validateProjectInputSources'
import {
  duplicateSourceIds,
  validateProjectInputSourceSummary
} from '@domain/project-files/services/validateProjectInputSourceSummary'
import { validateRequestedSourceIds } from '@domain/project-files/services/validateRequestedSourceIds'

function expectAppCode(run: () => unknown, code: ProjectFileErrorCode): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(AppException)
    expect(error).toMatchObject({ code })
    return
  }
  throw new Error(`expected AppException ${code}`)
}

function document(patch: Partial<ProjectDocumentSource> = {}): ProjectDocumentSource {
  return {
    sourceId: 'doc-1',
    version: 'v1',
    contentKind: 'text',
    textKind: 'document',
    title: '标题',
    body: '正文',
    topics: ['角色'],
    importFormat: 'markdown',
    ...patch
  }
}

function asset(patch: Partial<ProjectFileAssetSource> = {}): ProjectFileAssetSource {
  return {
    sourceId: 'asset-1',
    version: 'v1',
    contentKind: 'image',
    name: '工坊',
    fileId: 'file-1',
    description: '',
    ...patch
  }
}

function sourceCard(patch: Partial<SceneCanvasDocumentCard> = {}): SceneCanvasDocumentCard {
  return {
    cardId: 'card-1',
    kind: 'document',
    sourceId: 'doc-1',
    title: '设定',
    summary: '',
    layout: { x: 0, y: -10, width: 120, height: 80 },
    ...patch
  }
}

function promptCard(patch: Partial<SceneCanvasPromptCard> = {}): SceneCanvasPromptCard {
  return {
    cardId: 'card-prompt',
    kind: 'prompt',
    body: '保持短句',
    references: [],
    layout: { x: 20, y: 20, width: 120, height: 80 },
    ...patch
  }
}

function fieldCard(
  patch: {
    cardId?: string
    kind?: 'animation' | 'effect'
    webgalPreset?: SceneCanvasFieldCard['webgalPreset']
    layout?: SceneCanvasFieldCard['layout']
  } = {}
): SceneCanvasFieldCard {
  const shared = {
    cardId: patch.cardId ?? 'card-anim',
    webgalPreset:
      patch.webgalPreset === undefined
        ? { command: 'setAnimation', name: 'enter' }
        : patch.webgalPreset,
    layout: patch.layout ?? { x: 10, y: 20, width: 120, height: 80 }
  }
  if (patch.kind === 'effect') return { ...shared, kind: 'effect' }
  return { ...shared, kind: 'animation' }
}

function arrangement(patch: Partial<SceneCanvasArrangement> = {}): SceneCanvasArrangement {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    canvasId: 'canvas-1',
    viewport: { x: 0, y: 0, zoom: 1 },
    cards: [sourceCard()],
    relations: [],
    ...patch
  }
}

describe('validateProjectInputSource', () => {
  it('接受文档和文件素材的必需事实，且不要求路径或媒体字节', () => {
    expect(() => validateProjectInputSource(document())).not.toThrow()
    expect(() => validateProjectInputSource(asset({ description: '' }))).not.toThrow()
  })

  it('拒绝空白身份、空白必需内容和不受支持的文件类型', () => {
    expectAppCode(
      () => validateProjectInputSource(document({ sourceId: '  ' })),
      ProjectFileErrorCodes.blankSourceId
    )
    expectAppCode(
      () => validateProjectInputSource(document({ version: '' })),
      ProjectFileErrorCodes.blankSourceVersion
    )
    expectAppCode(
      () => validateProjectInputSource(document({ title: ' ' })),
      ProjectFileErrorCodes.blankSourceContent
    )
    expectAppCode(
      () => validateProjectInputSource(asset({ fileId: '' })),
      ProjectFileErrorCodes.blankSourceContent
    )
    expectAppCode(
      () =>
        validateProjectInputSource({
          ...asset(),
          contentKind: 'animation-file'
        } as ProjectInputSource),
      ProjectFileErrorCodes.invalidAssetPurpose
    )
  })
})

describe('validateProjectInputSources', () => {
  it('拒绝同一窗口内的重复来源身份', () => {
    expectAppCode(
      () => validateProjectInputSources([document(), document({ title: '另一份' })]),
      ProjectFileErrorCodes.duplicateSourceId
    )
  })
})

describe('工程检查中的 v4 编排', () => {
  it('提示词卡片保存正文，不要求来源身份', () => {
    expect(
      inspectProjectFileFacts({
        projectId: 'project-1',
        inputSourceFormatSupported: true,
        canvasArrangementFormatSupported: true,
        sources: [{ availability: 'present', source: document() }],
        arrangements: [
          {
            availability: 'present',
            arrangement: arrangement({
              cards: [sourceCard(), promptCard()],
              relations: [
                {
                  relationId: 'rel-1',
                  fromCardId: 'card-1',
                  toCardId: 'card-prompt',
                  specificName: '',
                  recordCardId: 'card-prompt'
                }
              ]
            })
          }
        ]
      }).diagnostics
    ).toEqual([])
  })

  it('字段卡片允许未选择，并保留命令与名称结构', () => {
    expect(
      inspectProjectFileFacts({
        projectId: 'project-1',
        inputSourceFormatSupported: true,
        canvasArrangementFormatSupported: true,
        sources: [],
        arrangements: [
          {
            availability: 'present',
            arrangement: arrangement({
              cards: [
                fieldCard({ webgalPreset: null }),
                fieldCard({
                  cardId: 'card-fx',
                  kind: 'effect',
                  webgalPreset: { command: 'pixiPerform', name: 'rain' }
                })
              ]
            })
          }
        ]
      }).diagnostics
    ).toEqual([])
  })

  it('领域不合法的 v4 编排记为损坏', () => {
    const card = sourceCard()
    expect(
      inspectProjectFileFacts({
        projectId: 'project-1',
        inputSourceFormatSupported: true,
        canvasArrangementFormatSupported: true,
        sources: [{ availability: 'present', source: document() }],
        arrangements: [
          { availability: 'present', arrangement: arrangement({ cards: [card, card] }) }
        ]
      }).diagnostics
    ).toEqual([{ objectId: 'canvas-1', kind: 'damaged' }])
  })
})

describe('inspectProjectFileFacts', () => {
  it('把缺失、损坏、重复身份、断开引用和不支持格式分开表达', () => {
    const facts: ProjectFileInspectionFacts = {
      projectId: 'project-1',
      inputSourceFormatSupported: false,
      canvasArrangementFormatSupported: true,
      sources: [
        { availability: 'present', source: document() },
        { availability: 'missing', sourceId: 'gone' },
        { availability: 'damaged', sourceId: 'broken' },
        { availability: 'missing', sourceId: 'gone' }
      ],
      arrangements: [
        {
          availability: 'present',
          arrangement: arrangement({
            cards: [
              arrangement().cards[0],
              sourceCard({
                cardId: 'card-missing',
                sourceId: 'gone',
                layout: { x: 1, y: 1, width: 10, height: 10 }
              })
            ]
          })
        }
      ]
    }

    expect(inspectProjectFileFacts(facts)).toEqual({
      projectId: 'project-1',
      inputSourceFormatSupported: false,
      canvasArrangementFormatSupported: true,
      diagnostics: [
        { objectId: 'gone', kind: 'missing' },
        { objectId: 'broken', kind: 'damaged' },
        { objectId: 'gone', kind: 'missing' },
        { objectId: 'gone', kind: 'duplicateIdentity' },
        { objectId: 'card-missing', kind: 'brokenReference' }
      ]
    })
  })

  it('业务不合法的已解析来源记为损坏，没有身份的事实仍然失败', () => {
    expect(
      inspectProjectFileFacts({
        projectId: 'project-1',
        inputSourceFormatSupported: true,
        canvasArrangementFormatSupported: false,
        sources: [{ availability: 'present', source: document({ title: '' }) }],
        arrangements: [{ availability: 'damaged', objectId: 'canvas-broken' }]
      }).diagnostics
    ).toEqual([
      { objectId: 'doc-1', kind: 'damaged' },
      { objectId: 'canvas-broken', kind: 'damaged' }
    ])
    expectAppCode(
      () =>
        inspectProjectFileFacts({
          projectId: ' ',
          inputSourceFormatSupported: true,
          canvasArrangementFormatSupported: true,
          sources: [],
          arrangements: []
        }),
      ProjectFileErrorCodes.blankArrangementIdentity
    )
  })

  it('多份编排分别保留断开引用，同一场景画布的重复身份不合并', () => {
    const result = inspectProjectFileFacts({
      projectId: 'project-1',
      inputSourceFormatSupported: true,
      canvasArrangementFormatSupported: true,
      sources: [{ availability: 'present', source: document() }],
      arrangements: [
        { availability: 'present', arrangement: arrangement() },
        {
          availability: 'present',
          arrangement: arrangement({
            canvasId: 'canvas-2',
            cards: [
              sourceCard({
                cardId: 'card-2',
                sourceId: 'missing-source',
                layout: { x: 0, y: 0, width: 8, height: 8 }
              }),
              sourceCard({
                cardId: 'card-3',
                sourceId: 'doc-1',
                layout: { x: 4, y: 4, width: 8, height: 8 }
              }),
              fieldCard({
                cardId: 'card-field',
                webgalPreset: { command: 'setAnimation', name: 'enter' }
              })
            ]
          })
        },
        { availability: 'present', arrangement: arrangement() }
      ]
    })
    expect(result.diagnostics).toEqual([
      { objectId: 'card-2', kind: 'brokenReference' },
      { objectId: 'canvas-1', kind: 'duplicateIdentity' }
    ])
  })
})

describe('validateRequestedSourceIds', () => {
  it('拒绝空白和重复身份，且不修剪后当作另一个身份', () => {
    expect(() => validateRequestedSourceIds([' id ', 'other'])).not.toThrow()
    expectAppCode(
      () => validateRequestedSourceIds(['ok', '  ']),
      ProjectFileErrorCodes.blankSourceId
    )
    expectAppCode(
      () => validateRequestedSourceIds(['same', 'same']),
      ProjectFileErrorCodes.duplicateSourceId
    )
    expect(() => validateRequestedSourceIds(['same', ' same '])).not.toThrow()
  })
})

describe('validateProjectInputSourceSummary', () => {
  it('校验身份、类别和文本子类型；空白名称改为不可读，不为摘要构造正文', () => {
    expect(() =>
      validateProjectInputSourceSummary({
        sourceId: 'doc-1',
        name: '标题',
        readable: true,
        contentKind: 'text',
        textKind: 'document'
      })
    ).not.toThrow()
    expect(() =>
      validateProjectInputSourceSummary({
        sourceId: 'asset-1',
        name: '',
        readable: false,
        contentKind: 'image'
      })
    ).not.toThrow()
    expect(
      validateProjectInputSourceSummary({
        sourceId: 'doc-1',
        name: '  ',
        readable: true,
        contentKind: 'text',
        textKind: 'document'
      })
    ).toEqual({
      sourceId: 'doc-1',
      name: '  ',
      readable: false,
      contentKind: 'text',
      textKind: 'document'
    })
    expectAppCode(
      () =>
        validateProjectInputSourceSummary({
          sourceId: '  ',
          name: '标题',
          readable: true,
          contentKind: 'text',
          textKind: 'document'
        }),
      ProjectFileErrorCodes.blankSourceId
    )
    expectAppCode(
      () =>
        validateProjectInputSourceSummary({
          sourceId: 'doc-1',
          name: '标题',
          readable: true,
          contentKind: 'text',
          textKind: 'script' as 'document'
        }),
      ProjectFileErrorCodes.blankSourceContent
    )
    expect(duplicateSourceIds(['a', 'b', 'a'])).toEqual(new Set(['a']))
  })
})
