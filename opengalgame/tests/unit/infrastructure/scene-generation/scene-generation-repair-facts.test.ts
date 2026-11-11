import { describe, expect, it } from 'vitest'

import type {
  SceneGenerationCandidate,
  SceneGenerationExecution
} from '@application/scene-generation/models/SceneGenerationExecution'
import type { SceneValidationReport } from '@domain/scene-generation/models/SceneValidationReport'
import { estimateTokens } from '@infrastructure/ai/context/contextBudget'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { recordWrittenFile } from '@infrastructure/ai/execution/writtenFileLedger'
import { runStateBlock } from '@infrastructure/scene-generation/agents/context/ContextFactsInjector'
import { SceneGenerationContextAssemblerImpl } from '@infrastructure/scene-generation/agents/context/SceneGenerationContextAssemblerImpl'

const ENTRY = 'game/scene/start.txt'
const CANDIDATE_BODY_MARKER = '候选正文不该进入事实'
const REPAIR_NOTE = '源候选已复制到当前候选工作区，作为修复起点；本操作尚未重新提交'
const MIO_REAL_KEY = '64396666333032342d353666352d346233652d396331352d306237383566623162353838'
const MIO_WRONG_KEY = '64396666333032342d353666352d346233652d396331352d306237383566623162353538'

const diagnostics: SceneValidationReport = {
  issues: [
    {
      code: 'unknown-command',
      message: '未知命令 setBg',
      correctable: true,
      requiresHumanDecision: false
    }
  ]
}

function repairExecution(
  overrides: Partial<SceneGenerationExecution> = {}
): SceneGenerationExecution {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-2',
    threadId: 'thread-2',
    branchId: 'branch-2',
    mode: 'repair',
    source: { sceneDirectory: 'game/scene', entryFile: 'start.txt' },
    inputSnapshot: { assets: [] },
    budget: {},
    replies: [],
    checkpointId: 'checkpoint-2',
    repairSource: {
      operationId: 'operation-1',
      threadId: 'thread-1',
      branchId: 'branch-1',
      checkpointId: 'checkpoint-1',
      candidateSnapshotId: 'candidate-1'
    },
    repairContext: {
      sourceOperationId: 'operation-1',
      sourceThreadId: 'thread-1',
      sourceBranchId: 'branch-1',
      sourceCheckpointId: 'checkpoint-1',
      sourceCandidateSnapshotId: 'candidate-1',
      candidatePath: ENTRY,
      instruction: '把开场的光线调暗',
      summary: '来源摘要',
      confirmedReplies: [
        { kind: 'revise', body: '第一轮修改' },
        { kind: 'clarify', body: '已确认的澄清' }
      ],
      unresolvedIssues: ['未解决冲突'],
      validationReport: diagnostics,
      failureClass: 'outputContract',
      failureReason: 'structuredOutput',
      failureMessage: '候选未通过'
    },
    repairInputSnapshotId: 'repair-input-1',
    ...overrides
  } as SceneGenerationExecution
}

function candidateWithBodyMarker(): SceneGenerationCandidate {
  return {
    candidateSnapshotId: 'candidate-2',
    artifact: {
      scene: { projectId: 'project-1', sceneId: 'scene-1' },
      hasEntry: true,
      statements: [{ sequence: 0, command: 'setBg', content: CANDIDATE_BODY_MARKER }]
    },
    preview: {
      entryFile: 'start.txt',
      files: [ENTRY],
      parserVersion: '1.0.0',
      commandLocations: [{ sequence: 0, filePath: ENTRY, line: 1, engineSentenceIndex: 0 }],
      assetLocations: [],
      validationReport: diagnostics
    },
    assetChanges: []
  } as unknown as SceneGenerationCandidate
}

function freshBudget(): ExecutionBudget {
  return new ExecutionBudget({ modelAttempts: 10, toolCalls: 10, activeMs: 60_000 })
}

describe('SceneGenerationContextAssemblerImpl 修复上下文事实', () => {
  it('修复重跑事实带源候选坐标与失败上下文，不带候选正文', () => {
    const assembled = JSON.parse(
      new SceneGenerationContextAssemblerImpl().assemble({
        mode: 'repair',
        execution: repairExecution(),
        candidate: candidateWithBodyMarker(),
        summary: '本轮摘要'
      })
    ) as {
      repair: unknown
      acceptedReplies: readonly unknown[]
      historySummary?: string
      candidateFiles?: readonly string[]
    }

    expect(assembled.repair).toEqual({
      candidate: {
        path: ENTRY,
        sourceRevision: 'candidate-1',
        workspaceRevision: 'repair-input-1',
        note: REPAIR_NOTE
      },
      instruction: '把开场的光线调暗',
      previousSummary: '来源摘要',
      previousFailure: {
        class: 'outputContract',
        reason: 'structuredOutput',
        message: '候选未通过'
      },
      confirmedReplies: [
        { kind: 'revise', body: '第一轮修改' },
        { kind: 'clarify', body: '已确认的澄清' }
      ],
      unresolvedIssues: ['未解决冲突'],
      diagnostics
    })
    expect(assembled.acceptedReplies).toEqual([])
    expect(assembled.historySummary).toBe('本轮摘要')
    expect(assembled.candidateFiles).toEqual([ENTRY])
    expect(JSON.stringify(assembled)).not.toContain(CANDIDATE_BODY_MARKER)
  })

  it('修复轮事实给出缺失素材的正确引用、素材名与入口行号', () => {
    const enriched: SceneValidationReport = {
      issues: [
        {
          code: 'missing-asset',
          message: '素材引用在工程中不存在',
          sequence: 4,
          reference: `${MIO_WRONG_KEY}/josei_01_a.png`,
          line: 9,
          nearestReference: `${MIO_REAL_KEY}/josei_01_a.png`,
          nearestAssetName: '澪',
          nearestAssetPath: `assets/${MIO_REAL_KEY}/josei_01_a.png`,
          correctable: true,
          requiresHumanDecision: false
        }
      ]
    }
    const assetUsage = { targetIds: [] }
    const execution = repairExecution({
      inputSnapshot: {
        canvasId: 'canvas-1',
        arrangementVersion: 'v1',
        assets: [
          {
            assetId: 'mio',
            sourceId: 'mio-source',
            name: '澪',
            relativePath: `assets/${MIO_REAL_KEY}/josei_01_a.png`,
            category: 'image',
            description: '立绘',
            usage: assetUsage
          }
        ],
        documents: [],
        prompts: [],
        fieldBindings: [],
        relations: [],
        confirmedControls: []
      },
      repairContext: { ...repairExecution().repairContext!, validationReport: enriched }
    })
    const candidate = candidateWithBodyMarker()
    candidate.preview.validationReport = enriched

    const assembled = JSON.parse(
      new SceneGenerationContextAssemblerImpl().assemble({
        mode: 'repair',
        execution,
        candidate
      })
    ) as {
      diagnostics: unknown
      missingAssetHints?: readonly string[]
      repair?: { missingAssetHints?: readonly string[] }
    }

    expect(assembled.diagnostics).toEqual(enriched)
    expect(assembled.missingAssetHints?.[0]).toContain('第 9 行的素材引用')
    const hint = assembled.missingAssetHints?.[0] ?? ''
    expect(hint).toContain(MIO_WRONG_KEY)
    expect(hint).toContain(MIO_REAL_KEY)
    expect(hint).toContain('澪')
    expect(hint).toContain(`assets/${MIO_REAL_KEY}/josei_01_a.png`)
    expect(assembled.repair?.missingAssetHints).toEqual(assembled.missingAssetHints)
  })

  it('缺失的可选来源事实逐项省略，不补造空串或空数组', () => {
    const execution = repairExecution({
      repairInputSnapshotId: undefined,
      repairContext: {
        sourceOperationId: 'operation-1',
        sourceThreadId: 'thread-1',
        sourceBranchId: 'branch-1',
        sourceCheckpointId: 'checkpoint-1',
        sourceCandidateSnapshotId: 'candidate-1',
        candidatePath: ENTRY,
        instruction: '重做开场',
        summary: '   ',
        confirmedReplies: [],
        unresolvedIssues: []
      }
    })
    const assembled = JSON.parse(
      new SceneGenerationContextAssemblerImpl().assemble({ mode: 'repair', execution })
    ) as { repair: Record<string, unknown> }

    expect(assembled.repair).toEqual({
      candidate: {
        path: ENTRY,
        sourceRevision: 'candidate-1',
        note: REPAIR_NOTE
      },
      instruction: '重做开场',
      confirmedReplies: []
    })
  })

  it('旧记录没有修复上下文时不输出 repair 块', () => {
    const assembled = JSON.parse(
      new SceneGenerationContextAssemblerImpl().assemble({
        mode: 'generate',
        execution: repairExecution({
          repairContext: undefined,
          repairSource: undefined,
          repairInputSnapshotId: undefined
        })
      })
    ) as Record<string, unknown>

    expect(assembled).not.toHaveProperty('repair')
  })

  it('继续修改仍输出候选文件、摘要与已确认回复', () => {
    const assembled = JSON.parse(
      new SceneGenerationContextAssemblerImpl().assemble({
        mode: 'repair',
        execution: repairExecution({
          repairContext: undefined,
          repairSource: undefined,
          repairInputSnapshotId: undefined
        }),
        candidate: candidateWithBodyMarker(),
        summary: '继续修改摘要',
        confirmedReplies: [
          {
            projectId: 'project-1',
            sceneId: 'scene-1',
            operationId: 'operation-2',
            threadId: 'thread-2',
            branchId: 'branch-2',
            interactionId: 'interaction-1',
            checkpointId: 'checkpoint-2',
            replyId: 'reply-1',
            reply: { kind: 'revise', body: '把走廊的灯关掉' }
          }
        ]
      })
    ) as {
      candidateFiles?: readonly string[]
      historySummary?: string
      acceptedReplies: readonly { reply: { kind: string; body?: string } }[]
    }

    expect(assembled.candidateFiles).toEqual([ENTRY])
    expect(assembled.historySummary).toBe('继续修改摘要')
    expect(assembled.acceptedReplies).toEqual([
      expect.objectContaining({ reply: { kind: 'revise', body: '把走廊的灯关掉' } })
    ])
  })
  it('事实快照只给素材类别和稳定引用，不含用途、默认目录或提示词角色', () => {
    const assetUsage = { targetIds: [] }
    const assembled = JSON.parse(
      new SceneGenerationContextAssemblerImpl().assemble({
        mode: 'generate',
        execution: repairExecution({
          mode: 'generate',
          repairContext: undefined,
          repairSource: undefined,
          repairInputSnapshotId: undefined,
          inputSnapshot: {
            canvasId: 'canvas-1',
            arrangementVersion: 'v1',
            assets: [
              {
                assetId: 'image-card',
                sourceId: 'image-source',
                name: '背景',
                relativePath: 'assets/background/room.webp',
                category: 'image',
                description: '室内',
                usage: assetUsage
              },
              {
                assetId: 'audio-card',
                sourceId: 'audio-source',
                name: '夜色',
                relativePath: 'assets/bgm/night.ogg',
                category: 'audio',
                description: '缓慢',
                usage: assetUsage
              },
              {
                assetId: 'video-card',
                sourceId: 'video-source',
                name: '开场',
                relativePath: 'game/video/opening.mp4',
                category: 'video',
                description: '',
                usage: assetUsage
              }
            ],
            documents: [],
            prompts: [
              {
                id: 'prompt-1',
                title: '提示',
                body: '用背景开场',
                scopes: [{ kind: 'scene' }],
                references: [{ cardId: 'image-card', kind: 'image', displayName: '背景' }],
                usage: assetUsage
              }
            ],
            fieldBindings: [],
            relations: [],
            confirmedControls: []
          }
        })
      })
    ) as {
      inputs: {
        assets: Record<string, unknown>[]
        prompts: { references: Record<string, unknown>[] }[]
      }
      assetBindings: Record<string, unknown>[]
    }

    expect(assembled.inputs.assets.map((asset) => asset.category)).toEqual([
      'image',
      'audio',
      'video'
    ])
    expect(assembled.inputs.assets.some((asset) => 'purpose' in asset)).toBe(false)
    expect(assembled.assetBindings.map((binding) => binding.category)).toEqual([
      'image',
      'audio',
      'video'
    ])
    expect(assembled.assetBindings.map((binding) => binding.commandReference)).toEqual([
      'room.webp',
      'night.ogg',
      'opening.mp4'
    ])
    expect(
      assembled.assetBindings.some(
        (binding) => 'purpose' in binding || 'defaultRuntimeDirectory' in binding
      )
    ).toBe(false)
    expect(assembled.inputs.prompts[0]?.references[0]).toEqual({
      cardId: 'image-card',
      kind: 'image',
      displayName: '背景'
    })
    expect(assembled.inputs.prompts[0]?.references[0]).not.toHaveProperty('role')
  })
})

describe('runStateBlock 修复重跑运行状态', () => {
  it('修复重跑尚未写入时显示源候选修复起点，不再提示提问', () => {
    const block = runStateBlock({
      executionMode: 'repair',
      writtenFiles: [],
      budget: freshBudget()
    })

    expect(block).toContain('候选：源候选可读（修复起点）')
    expect(block).not.toContain('候选：未写出')
    expect(block).not.toContain('request_clarification')
    expect(block).toContain('先读取源候选，再作最小修改')
    expect(estimateTokens(block)).toBeLessThanOrEqual(200)
  })

  it('普通生成尚未写入时仍显示未写出并保留提问提示', () => {
    const block = runStateBlock({
      executionMode: 'generate',
      writtenFiles: [],
      budget: freshBudget()
    })

    expect(block).toContain('候选：未写出')
    expect(block).toContain('request_clarification')
    expect(estimateTokens(block)).toBeLessThanOrEqual(200)
  })

  it('修复重跑已有权威候选时显示候选路径而不是修复起点', () => {
    const budget = freshBudget()
    recordWrittenFile(budget, { path: ENTRY, version: '120:1' })
    const block = runStateBlock({
      executionMode: 'repair',
      writtenFiles: [ENTRY],
      budget
    })

    expect(block).toContain(`候选：${ENTRY}（120 bytes，版本 120:1）`)
    expect(block).not.toContain('修复起点')
    expect(block).not.toContain('request_clarification')
    expect(estimateTokens(block)).toBeLessThanOrEqual(200)
  })
})
