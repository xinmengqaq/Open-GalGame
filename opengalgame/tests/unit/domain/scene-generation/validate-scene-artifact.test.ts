import { describe, expect, it } from 'vitest'

import { AppException } from '@common/errors/AppException'
import {
  SceneGenerationErrorCodes,
  type SceneGenerationErrorCode
} from '@domain/scene-generation/errors/SceneGenerationErrorCodes'
import type {
  SceneAssetUse,
  SceneGenerationArtifact,
  SceneGenerationStatement
} from '@domain/scene-generation/models/SceneGenerationArtifact'
import type {
  SceneGenerationAsset,
  SceneGenerationRequest
} from '@domain/scene-generation/models/SceneGenerationRequest'
import type { SceneValidationIssueCode } from '@domain/scene-generation/models/SceneValidationReport'
import { validateSceneArtifact } from '@domain/scene-generation/services/validateSceneArtifact'
import type { SceneAssetCategory } from '@domain/scenes/models/SceneAssetReference'

function expectAppCode(run: () => unknown, code: SceneGenerationErrorCode): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(AppException)
    expect(error).toMatchObject({ code })
    return
  }
  throw new Error(`expected AppException ${code}`)
}

function generationRequest(
  overrides: Partial<SceneGenerationRequest> = {}
): SceneGenerationRequest {
  return {
    scene: { projectId: 'project-1', sceneId: 'scene-1' },
    assets: [generationAsset('bg-1', 'image')],
    documents: [],
    prompts: [],
    fieldBindings: [],
    relations: [],
    maxCorrections: 2,
    correctionsUsed: 0,
    lockState: 'unlocked',
    baselineState: 'unchanged',
    confirmedControls: [],
    ...overrides
  }
}

function generationAsset(
  assetId: string,
  category: SceneAssetCategory,
  sourceId = assetId
): SceneGenerationAsset {
  return { assetId, category, sourceId }
}

function statement(
  command: string,
  overrides: Partial<SceneGenerationStatement> = {}
): SceneGenerationStatement {
  return {
    sequence: 0,
    command,
    commandRecognition: 'recognized',
    argumentRecognition: 'recognized',
    content: '',
    assetUses: [],
    ...overrides
  }
}

function matched(assetId: string, category: SceneAssetCategory): SceneAssetUse {
  return { assetId, category, outcome: 'matched' }
}

function artifact(
  statements: readonly SceneGenerationStatement[],
  overrides: Partial<SceneGenerationArtifact> = {}
): SceneGenerationArtifact {
  return {
    scene: { projectId: 'project-1', sceneId: 'scene-1' },
    hasEntry: true,
    statements,
    ...overrides
  }
}

function issueCodes(
  request: SceneGenerationRequest,
  candidate: SceneGenerationArtifact
): SceneValidationIssueCode[] {
  return validateSceneArtifact(candidate, request).issues.map((issue) => issue.code)
}

describe('validateSceneArtifact', () => {
  it('无姓名对白必须明确清空姓名，空 speaker 数值不作为姓名', () => {
    for (const dialogueSpeaker of ['implicit', 'numeric-zero'] as const) {
      expect(
        issueCodes(generationRequest(), artifact([statement('say', { dialogueSpeaker })]))
      ).toContain('implicit-speaker')
    }
    for (const dialogueSpeaker of ['cleared', 'explicit'] as const) {
      expect(
        issueCodes(generationRequest(), artifact([statement('say', { dialogueSpeaker })]))
      ).toEqual([])
    }
  })

  it('音效到 end 之间全是自动推进时报告调度问题，玩家等待隔开后通过', () => {
    const effect = statement('playEffect', { automaticAdvance: true })
    const stop = statement('bgm', { sequence: 1, automaticAdvance: true })
    const end = statement('end', { sequence: 3 })
    const report = validateSceneArtifact(artifact([effect, stop, end]), generationRequest())
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: 'automatic-effect-before-end',
        sequence: 0,
        correctable: true
      })
    )
    expect(
      issueCodes(
        generationRequest(),
        artifact([
          effect,
          stop,
          statement('say', { sequence: 2, automaticAdvance: false, dialogueSpeaker: 'cleared' }),
          end
        ])
      )
    ).toEqual([])
    expect(issueCodes(generationRequest(), artifact([effect]))).toEqual([])
    expect(
      issueCodes(
        generationRequest(),
        artifact([
          effect,
          statement('say', { automaticAdvance: true, dialogueSpeaker: 'cleared' }),
          end
        ])
      )
    ).toContain('automatic-effect-before-end')
  })

  it('条件跳过和同文件跳转不算玩家等待，不能因此漏掉音效调度问题', () => {
    const effect = statement('playEffect', { automaticAdvance: true, waitsForPlayer: false })
    const end = statement('end', { sequence: 3, waitsForPlayer: true })
    const skipped = statement('say', {
      sequence: 1,
      automaticAdvance: false,
      waitsForPlayer: false,
      dialogueSpeaker: 'cleared'
    })
    const jump = statement('jumpLabel', {
      sequence: 1,
      content: 'finish',
      automaticAdvance: false,
      waitsForPlayer: false
    })
    const label = statement('label', { sequence: 2, automaticAdvance: true, waitsForPlayer: false })
    expect(issueCodes(generationRequest(), artifact([effect, skipped, end]))).toContain(
      'automatic-effect-before-end'
    )
    expect(issueCodes(generationRequest(), artifact([effect, jump, label, end]))).toContain(
      'automatic-effect-before-end'
    )
    expect(
      issueCodes(
        generationRequest(),
        artifact([
          effect,
          statement('say', { sequence: 1, waitsForPlayer: true, dialogueSpeaker: 'cleared' }),
          end
        ])
      )
    ).not.toContain('automatic-effect-before-end')
  })

  it('被跳过的音效和结束不参与调度，同文件跳转从目标继续', () => {
    const effect = statement('playEffect', {
      automaticAdvance: true,
      waitsForPlayer: false
    })
    const skippedEffect = statement('playEffect', {
      automaticAdvance: true,
      waitsForPlayer: false,
      skipped: true
    })
    const skippedEnd = statement('end', { sequence: 1, skipped: true })
    const waiting = statement('say', {
      sequence: 2,
      waitsForPlayer: true,
      dialogueSpeaker: 'cleared'
    })
    const end = statement('end', { sequence: 3, waitsForPlayer: true })
    expect(issueCodes(generationRequest(), artifact([skippedEffect, end]))).not.toContain(
      'automatic-effect-before-end'
    )
    expect(
      issueCodes(generationRequest(), artifact([effect, skippedEnd, waiting, end]))
    ).not.toContain('automatic-effect-before-end')

    const jump = statement('jumpLabel', {
      sequence: 1,
      jumpTarget: 3,
      waitsForPlayer: false
    })
    const hiddenWait = statement('say', {
      sequence: 2,
      waitsForPlayer: true,
      dialogueSpeaker: 'cleared'
    })
    const label = statement('label', {
      sequence: 3,
      automaticAdvance: true,
      waitsForPlayer: false
    })
    const jumpedEnd = statement('end', { sequence: 4 })
    expect(
      issueCodes(generationRequest(), artifact([effect, jump, hiddenWait, label, jumpedEnd]))
    ).toContain('automatic-effect-before-end')
    const jumpOverEffect = statement('jumpLabel', {
      jumpTarget: 2,
      waitsForPlayer: false
    })
    const untouched = statement('playEffect', {
      sequence: 1,
      automaticAdvance: true,
      waitsForPlayer: false
    })
    const later = statement('label', { sequence: 2, automaticAdvance: true, waitsForPlayer: false })
    const bareEnd = statement('end', { sequence: 3 })
    expect(
      issueCodes(generationRequest(), artifact([jumpOverEffect, untouched, later, bareEnd]))
    ).not.toContain('automatic-effect-before-end')
  })

  it('连续对白缺少有效背景或角色时不能进入预览，齐备且清除后的场景可以通过', () => {
    const request = generationRequest({
      assets: [generationAsset('bg-1', 'image'), generationAsset('figure-1', 'image')]
    })
    const dialogue = [
      statement('say', { dialogueSpeaker: 'explicit', content: '第一句' }),
      statement('say', { sequence: 1, dialogueSpeaker: 'inherited', content: '第二句' })
    ]
    expect(issueCodes(request, artifact(dialogue))).toEqual(
      expect.arrayContaining(['missing-background', 'missing-character'])
    )

    const withContext = artifact([
      statement('changeBg', { assetUses: [matched('bg-1', 'image')] }),
      statement('changeFigure', {
        sequence: 1,
        assetUses: [matched('figure-1', 'image')]
      }),
      ...dialogue.map((item) => ({ ...item, sequence: item.sequence + 2 }))
    ])
    expect(issueCodes(request, withContext)).toEqual([])

    const cleared = artifact([
      statement('changeBg', { assetUses: [matched('bg-1', 'image')] }),
      statement('changeFigure', {
        sequence: 1,
        assetUses: [{ category: 'image', outcome: 'cleared' }]
      }),
      statement('changeBg', {
        sequence: 2,
        assetUses: [{ category: 'image', outcome: 'cleared' }]
      }),
      ...dialogue.map((item) => ({ ...item, sequence: item.sequence + 3 }))
    ])
    expect(issueCodes(request, cleared)).toEqual(
      expect.arrayContaining(['missing-background', 'missing-character'])
    )
    expect(issueCodes(request, artifact([]))).toEqual([])
  })

  it('按类别授权的立绘命令使用同类图片卡时也算已建立角色', () => {
    const request = generationRequest({
      assets: [generationAsset('bg-1', 'image'), generationAsset('figure-1', 'image')]
    })
    const dialogue = [
      statement('say', { dialogueSpeaker: 'explicit', content: '第一句' }),
      statement('say', { sequence: 1, dialogueSpeaker: 'inherited', content: '第二句' })
    ]
    const withCategoryContext = artifact([
      statement('changeBg', { assetUses: [matched('bg-1', 'image')] }),
      statement('changeFigure', {
        sequence: 1,
        assetUses: [matched('figure-1', 'image')]
      }),
      ...dialogue.map((item) => ({ ...item, sequence: item.sequence + 2 }))
    ])
    expect(issueCodes(request, withCategoryContext)).toEqual([])
  })

  it('被跳过或跳不到的背景和角色不能补上后面的连续对白', () => {
    const request = generationRequest({
      assets: [generationAsset('bg-1', 'image'), generationAsset('figure-1', 'image')]
    })
    const dialogue = [
      statement('say', { sequence: 2, dialogueSpeaker: 'explicit', content: '第一句' }),
      statement('say', { sequence: 3, dialogueSpeaker: 'inherited', content: '第二句' })
    ]
    const skippedContext = artifact([
      statement('changeBg', {
        assetUses: [matched('bg-1', 'image')],
        skipped: true
      }),
      statement('changeFigure', {
        sequence: 1,
        assetUses: [matched('figure-1', 'image')],
        skipped: true
      }),
      ...dialogue
    ])
    expect(issueCodes(request, skippedContext)).toEqual(
      expect.arrayContaining(['missing-background', 'missing-character'])
    )

    const jump = statement('jumpLabel', { jumpTarget: 3, waitsForPlayer: false })
    const hiddenBackground = statement('changeBg', {
      sequence: 1,
      assetUses: [matched('bg-1', 'image')]
    })
    const hiddenFigure = statement('changeFigure', {
      sequence: 2,
      assetUses: [matched('figure-1', 'image')]
    })
    const label = statement('label', { sequence: 3 })
    expect(
      issueCodes(
        request,
        artifact([
          jump,
          hiddenBackground,
          hiddenFigure,
          label,
          ...dialogue.map((item) => ({ ...item, sequence: item.sequence + 2 }))
        ])
      )
    ).toEqual(expect.arrayContaining(['missing-background', 'missing-character']))

    const reachable = artifact([
      statement('changeBg', { assetUses: [matched('bg-1', 'image')] }),
      statement('changeFigure', {
        sequence: 1,
        assetUses: [matched('figure-1', 'image')]
      }),
      statement('jumpLabel', { sequence: 2, jumpTarget: 5, waitsForPlayer: false }),
      statement('changeBg', {
        sequence: 3,
        assetUses: [{ category: 'image', outcome: 'cleared' }]
      }),
      statement('changeFigure', {
        sequence: 4,
        assetUses: [{ category: 'image', outcome: 'cleared' }]
      }),
      statement('label', { sequence: 5 }),
      ...dialogue.map((item) => ({ ...item, sequence: item.sequence + 4 }))
    ])
    expect(issueCodes(request, reachable)).toEqual([])

    const loop = artifact([
      ...dialogue,
      statement('label', { sequence: 4 }),
      statement('jumpLabel', { sequence: 5, jumpTarget: 4, waitsForPlayer: false }),
      statement('changeBg', {
        sequence: 6,
        assetUses: [matched('bg-1', 'image')]
      }),
      statement('changeFigure', {
        sequence: 7,
        assetUses: [matched('figure-1', 'image')]
      })
    ])
    expect(issueCodes(request, loop)).toEqual(
      expect.arrayContaining(['missing-background', 'missing-character'])
    )
  })

  it('接受线性台词、同文件跳转和合法背景', () => {
    const request = generationRequest({
      assets: [
        generationAsset('bg-1', 'image'),
        generationAsset('cg-1', 'image'),
        generationAsset('figure-1', 'image'),
        generationAsset('avatar-1', 'image'),
        generationAsset('bgm-1', 'audio'),
        generationAsset('se-1', 'audio'),
        generationAsset('voice-1', 'audio'),
        generationAsset('video-1', 'video')
      ]
    })
    const candidate = artifact([
      statement('say', { content: '你好', assetUses: [matched('voice-1', 'audio')] }),
      statement('changeBg', { sequence: 1, assetUses: [matched('bg-1', 'image')] }),
      statement('changeBg', { sequence: 2, assetUses: [matched('cg-1', 'image')] }),
      statement('changeFigure', {
        sequence: 3,
        assetUses: [matched('figure-1', 'image')]
      }),
      statement('changeFigureDiff', {
        sequence: 4,
        assetUses: [matched('figure-1', 'image')]
      }),
      statement('miniAvatar', { sequence: 5, assetUses: [matched('avatar-1', 'image')] }),
      statement('bgm', { sequence: 6, assetUses: [matched('bgm-1', 'audio')] }),
      statement('playEffect', { sequence: 7, assetUses: [matched('se-1', 'audio')] }),
      statement('playVideo', { sequence: 8, assetUses: [matched('video-1', 'video')] }),
      statement('label', { sequence: 9, content: 'again' }),
      statement('jumpLabel', { sequence: 10, content: 'again' }),
      statement('setVar', { sequence: 11, content: 'score=1' }),
      statement('showVars', { sequence: 12 }),
      statement('getUserInput', { sequence: 13 }),
      statement('return', { sequence: 14 })
    ])

    expect(validateSceneArtifact(candidate, request).issues).toEqual([])
  })

  it('同类素材可以按素材类别引用，跨类别仍报类别不一致', () => {
    const request = generationRequest({
      assets: [
        generationAsset('bg-1', 'image'),
        generationAsset('figure-1', 'image'),
        generationAsset('avatar-1', 'image'),
        generationAsset('voice-1', 'audio'),
        generationAsset('se-1', 'audio'),
        generationAsset('music-1', 'audio')
      ]
    })
    const accepted = [
      statement('changeFigure', { assetUses: [matched('bg-1', 'image')] }),
      statement('playEffect', { assetUses: [matched('voice-1', 'audio')] }),
      statement('bgm', { assetUses: [matched('music-1', 'audio')] }),
      statement('playEffect', { assetUses: [matched('music-1', 'audio')] }),
      statement('changeBg', { assetUses: [matched('figure-1', 'image')] }),
      statement('miniAvatar', { assetUses: [matched('avatar-1', 'image')] })
    ]
    for (const candidateStatement of accepted) {
      expect(validateSceneArtifact(artifact([candidateStatement]), request).issues).toEqual([])
    }

    const rejected = [
      statement('changeBg', { assetUses: [matched('voice-1', 'audio')] }),
      statement('bgm', { assetUses: [matched('bg-1', 'image')] }),
      statement('playVideo', { assetUses: [matched('figure-1', 'image')] }),
      statement('say', { assetUses: [matched('bg-1', 'image')] })
    ]
    for (const candidateStatement of rejected) {
      const report = validateSceneArtifact(artifact([candidateStatement]), request)
      expect(report.issues).toMatchObject([
        {
          code: 'purpose-mismatch',
          message: '素材类别与引用方式不一致',
          sequence: 0,
          correctable: true,
          requiresHumanDecision: false
        }
      ])
    }
  })

  it('禁止跨场景、选项和条件，同文件标签与推进参数除外', () => {
    const request = generationRequest({ assets: [] })
    const forbidden: Array<[string, SceneValidationIssueCode]> = [
      ['changeScene', 'scene-jump'],
      ['callScene', 'scene-jump'],
      ['choose', 'option-edge'],
      ['chooseLabel', 'option-edge'],
      ['if', 'condition']
    ]

    for (const [command, code] of forbidden) {
      const report = validateSceneArtifact(artifact([statement(command)]), request)
      expect(report.issues).toMatchObject([
        { code, sequence: 0, correctable: true, requiresHumanDecision: false }
      ])
    }

    expect(
      issueCodes(
        request,
        artifact([
          statement('say', { argumentRecognition: 'recognized', content: '继续 -next' }),
          statement('label', { sequence: 1 }),
          statement('jumpLabel', { sequence: 2 })
        ])
      )
    ).toEqual([])
  })

  it('只把内容一致的已确认控制留给人工', () => {
    const request = generationRequest({
      assets: [],
      prompts: [
        { id: 'prompt-1', title: '提示', body: '保留回家这个选项', scopes: [{ kind: 'scene' }] }
      ],
      confirmedControls: [{ kind: 'option', content: '回家:home', inputId: 'prompt-1' }]
    })
    const report = validateSceneArtifact(
      artifact([
        statement('choose', { content: '回家:home' }),
        statement('choose', { sequence: 1, content: '去商店:shop' })
      ]),
      request
    )

    expect(report.issues).toMatchObject([
      {
        code: 'option-edge',
        sequence: 0,
        correctable: true,
        requiresHumanDecision: true,
        message: expect.stringContaining('不能自动删除')
      },
      { code: 'option-edge', sequence: 1, correctable: true, requiresHumanDecision: false }
    ])
  })

  it('缺入口、未知命令、不可识别参数和坏引用可以修正', () => {
    const request = generationRequest({ assets: [generationAsset('bg-1', 'image')] })
    const candidate = artifact(
      [
        statement('mystery', { commandRecognition: 'unknown' }),
        statement('changeBg', { sequence: 1, argumentRecognition: 'invalid' }),
        statement('changeBg', {
          sequence: 2,
          assetUses: [{ category: 'image', outcome: 'unauthorized' }]
        }),
        statement('changeBg', {
          sequence: 3,
          assetUses: [{ category: 'image', outcome: 'missing', assetId: 'bg-1' }]
        }),
        statement('changeBg', {
          sequence: 4,
          assetUses: [{ category: 'image', outcome: 'external' }]
        }),
        statement('changeBg', {
          sequence: 5,
          assetUses: [{ category: 'image', outcome: 'invalid-path' }]
        }),
        statement('changeBg', {
          sequence: 6,
          assetUses: [{ category: 'image', outcome: 'matched', assetId: 'other' }]
        })
      ],
      { hasEntry: false }
    )

    expect(issueCodes(request, candidate)).toEqual([
      'missing-entry',
      'unknown-command',
      'invalid-argument',
      'unauthorized-asset',
      'missing-asset',
      'external-asset',
      'invalid-path',
      'unauthorized-asset'
    ])
    expect(
      validateSceneArtifact(candidate, request).issues.every((issue) => issue.correctable)
    ).toBe(true)
  })

  it('缺失素材问题保留候选实际引用与入口行号', () => {
    const request = generationRequest({ assets: [generationAsset('bg-1', 'image')] })
    const candidate = artifact([
      statement('changeBg', {
        assetUses: [
          {
            category: 'image',
            outcome: 'missing',
            reference: 'assets/wrong/room.webp',
            line: 12
          }
        ]
      })
    ])

    expect(validateSceneArtifact(candidate, request).issues).toEqual([
      expect.objectContaining({
        code: 'missing-asset',
        sequence: 0,
        reference: 'assets/wrong/room.webp',
        line: 12
      })
    ])
  })

  it('生成契约把未知命令和角色简写标成可修正问题，官方兼容语句仍通过', () => {
    const request = generationRequest()
    const report = validateSceneArtifact(
      artifact([
        statement('say', {
          commandRecognition: 'unknown',
          content: 'theme.ogg',
          syntaxContract: 'generated-candidate',
          contractIssue: 'unknown-command',
          contractMessage: '命令 playBgm 不受当前解析器支持，请改用已支持命令'
        }),
        statement('say', {
          sequence: 1,
          content: '',
          commandRecognition: 'unknown',
          syntaxContract: 'generated-candidate',
          contractIssue: 'unknown-command',
          contractMessage: '命令 stopBgm 不受当前解析器支持，请改用已支持命令'
        }),
        statement('say', {
          sequence: 2,
          dialogueSpeaker: 'implicit',
          content: '车站的灯亮了。',
          syntaxContract: 'generated-candidate',
          contractIssue: 'unsupported-dialogue'
        }),
        statement('say', {
          sequence: 3,
          dialogueSpeaker: 'inherited',
          content: '傍晚的空地',
          syntaxContract: 'generated-candidate',
          contractIssue: 'unsupported-dialogue'
        })
      ]),
      request
    )

    expect(report.issues).toMatchObject([
      {
        code: 'unknown-command',
        sequence: 0,
        correctable: true,
        message: '候选含有当前解析器不能识别的命令，请改用已支持命令'
      },
      {
        code: 'unknown-command',
        sequence: 1,
        correctable: true,
        message: '候选含有当前解析器不能识别的命令，请改用已支持命令'
      },
      { code: 'implicit-speaker', sequence: 2, correctable: true },
      { code: 'unsupported-dialogue', sequence: 2, correctable: true },
      { code: 'unsupported-dialogue', sequence: 3, correctable: true }
    ])
    expect(
      issueCodes(
        request,
        artifact([
          statement('bgm', { syntaxContract: 'generated-candidate' }),
          statement('bgm', { sequence: 1, syntaxContract: 'generated-candidate', content: '' }),
          statement('playEffect', { sequence: 2, syntaxContract: 'generated-candidate' }),
          statement('say', {
            sequence: 3,
            dialogueSpeaker: 'explicit',
            syntaxContract: 'generated-candidate'
          }),
          statement('say', {
            sequence: 4,
            dialogueSpeaker: 'cleared',
            syntaxContract: 'generated-candidate'
          })
        ])
      ).filter((code) => code === 'unknown-command' || code === 'unsupported-dialogue')
    ).toEqual([])
    expect(
      issueCodes(
        request,
        artifact([
          statement('say', { dialogueSpeaker: 'explicit', content: '林的台词' }),
          statement('say', { sequence: 1, dialogueSpeaker: 'inherited', content: '裸行' })
        ])
      ).filter((code) => code === 'unknown-command' || code === 'unsupported-dialogue')
    ).toEqual([])
  })

  it('清除引用不是缺文件，空语句也可以通过', () => {
    const request = generationRequest()
    const candidate = artifact([
      statement('changeBg', {
        assetUses: [{ category: 'image', outcome: 'cleared' }]
      })
    ])

    expect(validateSceneArtifact(candidate, request).issues).toEqual([])
    expect(validateSceneArtifact(artifact([]), request).issues).toEqual([])
  })

  it('候选身份与目标不一致时不可修正', () => {
    const report = validateSceneArtifact(
      artifact([statement('say')], { scene: { projectId: 'project-1', sceneId: 'scene-2' } }),
      generationRequest()
    )

    expect(report.issues).toMatchObject([
      { code: 'identity-mismatch', correctable: false, requiresHumanDecision: false }
    ])
  })

  it('空白身份、空白素材和重复素材直接拒绝', () => {
    expectAppCode(
      () =>
        validateSceneArtifact(
          artifact([]),
          generationRequest({ scene: { projectId: ' ', sceneId: 'scene-1' } })
        ),
      SceneGenerationErrorCodes.blankProjectId
    )
    expectAppCode(
      () =>
        validateSceneArtifact(
          artifact([]),
          generationRequest({ scene: { projectId: 'project-1', sceneId: '' } })
        ),
      SceneGenerationErrorCodes.blankSceneId
    )
    expectAppCode(
      () =>
        validateSceneArtifact(
          artifact([]),
          generationRequest({ assets: [generationAsset(' ', 'image')] })
        ),
      SceneGenerationErrorCodes.blankAssetId
    )
    expectAppCode(
      () =>
        validateSceneArtifact(
          artifact([]),
          generationRequest({
            assets: [generationAsset('bg-1', 'image'), generationAsset('bg-1', 'image', 'card-cg')]
          })
        ),
      SceneGenerationErrorCodes.duplicateAssetId
    )
    expectAppCode(
      () =>
        validateSceneArtifact(
          artifact([]),
          generationRequest({
            documents: [{ id: 'doc-1', sourceId: ' ', title: '角色', body: '她沉默', topics: [] }]
          })
        ),
      SceneGenerationErrorCodes.blankSourceId
    )
    expectAppCode(
      () =>
        validateSceneArtifact(
          artifact([]),
          generationRequest({
            prompts: [
              { id: 'prompt-1', sourceId: 'card-prompt', body: '写短一点' },
              { id: 'prompt-1', sourceId: 'card-prompt-2', body: '再写短一点' }
            ]
          })
        ),
      SceneGenerationErrorCodes.duplicatePromptId
    )
    expectAppCode(
      () =>
        validateSceneArtifact(
          artifact([]),
          generationRequest({
            documents: [
              { id: 'doc-1', sourceId: 'card-doc', title: '角色', body: ' ', topics: ['人物'] }
            ]
          })
        ),
      SceneGenerationErrorCodes.blankDocumentBody
    )
    expectAppCode(
      () =>
        validateSceneArtifact(
          artifact([]),
          generationRequest({
            prompts: [
              { id: 'prompt-1', title: '提示', body: '保留这个选项', scopes: [{ kind: 'scene' }] }
            ],
            confirmedControls: [{ kind: 'option', content: ' ', inputId: 'prompt-1' }]
          })
        ),
      SceneGenerationErrorCodes.blankConfirmedContent
    )
    expectAppCode(
      () =>
        validateSceneArtifact(
          artifact([]),
          generationRequest({
            assets: [generationAsset('bg-1', 'image')],
            confirmedControls: [{ kind: 'option', content: '回家:home', inputId: 'bg-1' }]
          })
        ),
      SceneGenerationErrorCodes.unknownConfirmedInput
    )
  })
})
