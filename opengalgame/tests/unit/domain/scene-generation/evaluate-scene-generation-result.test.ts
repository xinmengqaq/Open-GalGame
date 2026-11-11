import { describe, expect, it } from 'vitest'

import type { SceneGenerationArtifact } from '@domain/scene-generation/models/SceneGenerationArtifact'
import type { SceneGenerationRequest } from '@domain/scene-generation/models/SceneGenerationRequest'
import type { SceneCandidateJudgment } from '@domain/scene-generation/models/SceneCandidateJudgment'
import { evaluateSceneGenerationResult } from '@domain/scene-generation/services/evaluateSceneGenerationResult'
import { validateSceneArtifact } from '@domain/scene-generation/services/validateSceneArtifact'

function generationRequest(
  overrides: Partial<SceneGenerationRequest> = {}
): SceneGenerationRequest {
  return {
    scene: { projectId: 'project-1', sceneId: 'scene-1' },
    assets: [{ assetId: 'bg-1', category: 'image', sourceId: 'bg-1' }],
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

function artifact(overrides: Partial<SceneGenerationArtifact> = {}): SceneGenerationArtifact {
  return {
    scene: { projectId: 'project-1', sceneId: 'scene-1' },
    hasEntry: true,
    statements: [
      {
        sequence: 0,
        command: 'say',
        commandRecognition: 'recognized',
        argumentRecognition: 'recognized',
        content: '你好',
        assetUses: []
      }
    ],
    ...overrides
  }
}

function judge(request: SceneGenerationRequest, candidate = artifact()): SceneCandidateJudgment {
  return evaluateSceneGenerationResult(validateSceneArtifact(candidate, request), request)
}

describe('evaluateSceneGenerationResult', () => {
  it('内容通过且允许覆盖时接受', () => {
    const result = judge(generationRequest({ correctionsUsed: 2, maxCorrections: 1 }))

    expect(result.status).toBe('acceptable')
    expect(result.report.issues).toEqual([])
  })

  it('次数用尽仍可修正', () => {
    const candidate = artifact({ hasEntry: false, statements: [] })
    const request = generationRequest({ correctionsUsed: 2, maxCorrections: 2 })
    const continued = judge(request, candidate)

    expect(continued.status).toBe('correctable')
    expect(continued.report.issues).toMatchObject([{ code: 'missing-entry', correctable: true }])
  })

  it('锁定、锁定不明、基线变化和基线不明都不能覆盖', () => {
    const cases: Array<[Partial<SceneGenerationRequest>, string]> = [
      [{ lockState: 'locked' }, 'scene-locked'],
      [{ lockState: 'unknown' }, 'lock-unknown'],
      [{ baselineState: 'changed' }, 'baseline-changed'],
      [{ baselineState: 'unknown' }, 'baseline-unknown']
    ]

    for (const [overrides, code] of cases) {
      const result = judge(generationRequest(overrides))
      expect(result.status).toBe('rejected')
      expect(result.report.issues).toMatchObject([
        { code, correctable: false, requiresHumanDecision: false }
      ])
    }
  })

  it('内容还能修正但目标不能覆盖时拒绝', () => {
    const result = judge(generationRequest({ lockState: 'locked' }), artifact({ hasEntry: false }))

    expect(result.status).toBe('rejected')
    expect(result.report.issues.map((issue) => issue.code)).toEqual([
      'missing-entry',
      'scene-locked'
    ])
  })

  it('已确认控制需要人工，次数用尽也不改判成普通失败', () => {
    const request = generationRequest({
      assets: [],
      prompts: [
        { id: 'prompt-1', title: '提示', body: '保留离开这个选项', scopes: [{ kind: 'scene' }] }
      ],
      confirmedControls: [{ kind: 'option', content: '留下:stay|离开:leave', inputId: 'prompt-1' }],
      correctionsUsed: 3,
      maxCorrections: 1
    })
    const candidate = artifact({
      statements: [
        {
          sequence: 0,
          command: 'choose',
          commandRecognition: 'recognized',
          argumentRecognition: 'recognized',
          content: '留下:stay|离开:leave',
          assetUses: []
        }
      ]
    })
    const result = judge(request, candidate)

    expect(result.status).toBe('needsDecision')
    expect(result.report.issues).toMatchObject([
      { code: 'option-edge', requiresHumanDecision: true }
    ])
  })

  it('身份不一致不可修正，直接拒绝', () => {
    const result = judge(
      generationRequest(),
      artifact({ scene: { projectId: 'project-2', sceneId: 'scene-1' } })
    )

    expect(result.status).toBe('rejected')
    expect(result.report.issues).toMatchObject([{ code: 'identity-mismatch', correctable: false }])
  })
})
