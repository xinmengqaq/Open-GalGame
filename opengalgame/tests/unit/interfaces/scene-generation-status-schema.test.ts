import { describe, expect, it } from 'vitest'

import type { SceneGenerationRenderStatusVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import {
  parseSceneGenerationHistoryResult,
  parseSceneGenerationStatusResult
} from '@interfaces/scene-generation/contracts/SceneGenerationResponseSchema'
import { replySceneGenerationSchema } from '@interfaces/scene-generation/ipc/SceneGenerationRequestSchema'

function status(
  overrides: Partial<SceneGenerationRenderStatusVO> = {}
): SceneGenerationRenderStatusVO {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-1',
    threadId: 'thread-1',
    branchId: 'branch-1',
    state: 'interrupted',
    stage: 'paused',
    stageMessage: '已暂停，可继续',
    attempt: 1,
    sequence: 4,
    canPause: false,
    canResume: true,
    canCancel: true,
    inputSummary: {
      canvasId: 'canvas-1',
      arrangementVersion: 'saved-version',
      documentCount: 1,
      assetCount: 0,
      promptCount: 1,
      fieldBindingCount: 0,
      relationCount: 0,
      confirmedControlCount: 0
    },
    usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18, tokenLimit: null },
    previewAvailable: false,
    ...overrides
  }
}

function success(data: unknown): { code: number; msg: string; data: unknown } {
  return { code: ErrorCodes.success, msg: '生成状态已读取', data }
}

describe('渲染状态严格响应', () => {
  it('接受当前检查点，旧响应没有检查点时仍可解析', () => {
    const current = parseSceneGenerationStatusResult(
      success(
        status({
          checkpointId: 'checkpoint-current',
          candidateSnapshotId: 'snapshot-current',
          updatedAt: '2026-10-31T12:34:56.789Z'
        })
      )
    )
    expect(current?.data).toMatchObject({
      checkpointId: 'checkpoint-current',
      candidateSnapshotId: 'snapshot-current',
      operationId: 'operation-1',
      threadId: 'thread-1',
      branchId: 'branch-1',
      updatedAt: '2026-10-31T12:34:56.789Z'
    })

    const legacy = parseSceneGenerationStatusResult(success(status()))
    expect(legacy?.data?.operationId).toBe('operation-1')
    expect(legacy?.data?.checkpointId).toBeUndefined()
    expect(legacy?.data?.updatedAt).toBeUndefined()
  })

  it('接受输入摘要的安全明细，拒绝超长、超量和额外字段', () => {
    const details = {
      documents: ['角色与场景'],
      prompts: ['基础生成 · 场景'],
      relations: ['林晚与场景（记录：文档）']
    }
    const parsed = parseSceneGenerationStatusResult(
      success(status({ inputSummary: { ...status().inputSummary, details } }))
    )
    expect(parsed?.data?.inputSummary.details).toEqual(details)
    expect(
      parseSceneGenerationStatusResult(success(status()))?.data?.inputSummary.details
    ).toBeUndefined()

    expect(
      parseSceneGenerationStatusResult(
        success(
          status({
            inputSummary: {
              ...status().inputSummary,
              details: { relations: Array.from({ length: 13 }, (_, index) => `关系 ${index + 1}`) }
            }
          })
        )
      )
    ).toBeNull()
    expect(
      parseSceneGenerationStatusResult(
        success(
          status({
            inputSummary: {
              ...status().inputSummary,
              details: { documents: ['x'.repeat(81)] }
            }
          })
        )
      )
    ).toBeNull()
    expect(
      parseSceneGenerationStatusResult(
        success(
          status({
            inputSummary: {
              ...status().inputSummary,
              details: { documents: ['角色与场景'], rawBody: '正文' } as never
            }
          })
        )
      )
    ).toBeNull()
  })

  it('接受已知问题的素材增强字段，旧五字段和未知字段边界不变', () => {
    const enhanced = {
      code: 'missing-asset' as const,
      message: '候选引用的素材不存在',
      sequence: 3,
      correctable: true,
      requiresHumanDecision: false,
      reference: 'bg 云还没有走',
      line: 12,
      nearestReference: 'bg 教室',
      nearestAssetName: '教室'
    }
    const parsed = parseSceneGenerationStatusResult(success(status({ knownIssues: [enhanced] })))
    expect(parsed?.data?.knownIssues?.[0]).toEqual(enhanced)

    const legacy = {
      code: 'missing-asset' as const,
      message: '候选引用的素材不存在',
      correctable: true,
      requiresHumanDecision: false
    }
    expect(
      parseSceneGenerationStatusResult(success(status({ knownIssues: [legacy] })))?.data
        ?.knownIssues
    ).toEqual([legacy])

    expect(
      parseSceneGenerationStatusResult(
        success(
          status({
            knownIssues: [{ ...enhanced, nearestAssetPath: 'assets/bg/教室.webp' } as never]
          })
        )
      )
    ).toBeNull()
    expect(
      parseSceneGenerationStatusResult(
        success(status({ knownIssues: [{ ...enhanced, line: 0 }] }))
      )
    ).toBeNull()
  })

  it('拒绝空检查点以及路径和内部执行字段', () => {
    expect(parseSceneGenerationStatusResult(success(status({ checkpointId: '' })))).toBeNull()
    expect(parseSceneGenerationStatusResult(success(status({ updatedAt: '' })))).toBeNull()
    expect(
      parseSceneGenerationStatusResult(
        success({
          ...status({ checkpointId: 'checkpoint-current' }),
          projectRoot: '/project',
          workspace: { rootDirectory: '/secret/workspace' },
          source: { sceneDirectory: 'scenes/scene-1' }
        })
      )
    ).toBeNull()
  })

  it('接受 1 到 4 题和已回答事实，拒绝 5 题、未知字段和内部记录', () => {
    const question = (index: number) => ({
      questionId: `q${index}`,
      prompt: `问题 ${index}`,
      options: [1, 2, 3].map((option) => ({
        id: `q${index}o${option}`,
        label: `选项 ${option}`,
        description: `说明 ${option}`
      }))
    })
    const questions = [1, 2, 3, 4].map(question)
    const parsed = parseSceneGenerationStatusResult(
      success(
        status({
          interaction: {
            interactionId: 'interaction-1',
            checkpointId: 'checkpoint-1',
            kind: 'decision',
            message: '请回答当前问题',
            options: [],
            questions,
            allowedReplies: ['answers', 'discard']
          },
          answeredQuestions: [
            {
              questionId: 'q1',
              prompt: '问题 1',
              optionId: 'q1o1',
              label: '选项 1',
              description: '说明 1'
            }
          ]
        })
      )
    )
    expect(parsed?.data?.interaction?.questions).toHaveLength(4)
    expect(JSON.stringify(parsed)).not.toContain('workspace')
    expect(
      parseSceneGenerationStatusResult(
        success(
          status({
            interaction: {
              interactionId: 'interaction-1',
              checkpointId: 'checkpoint-1',
              kind: 'decision',
              message: '太多问题',
              options: [],
              questions: [...questions, question(5)],
              allowedReplies: ['answers']
            }
          })
        )
      )
    ).toBeNull()
    expect(
      parseSceneGenerationStatusResult(
        success({ ...status(), execution: { replies: [] }, modelOutput: 'raw' })
      )
    ).toBeNull()
    expect(
      replySceneGenerationSchema.safeParse({
        projectId: 'project-1',
        sceneId: 'scene-1',
        operationId: 'operation-1',
        threadId: 'thread-1',
        branchId: 'branch-1',
        interactionId: 'interaction-1',
        checkpointId: 'checkpoint-1',
        replyId: 'reply-1',
        reply: {
          kind: 'answers',
          answers: [{ questionId: 'q1', optionId: 'q1o1', body: '补充', label: '伪造标题' }]
        }
      }).success
    ).toBe(false)
    expect(
      replySceneGenerationSchema.safeParse({
        projectId: 'project-1',
        sceneId: 'scene-1',
        operationId: 'operation-1',
        threadId: 'thread-1',
        branchId: 'branch-1',
        interactionId: 'interaction-1',
        checkpointId: 'checkpoint-1',
        replyId: 'reply-1',
        reply: { kind: 'answers', answers: [1, 2, 3, 4, 5].map(question) }
      }).success
    ).toBe(false)
  })

  it('保留安全失败分类和动作，拒绝分类、状态和原因名', () => {
    const parsed = parseSceneGenerationStatusResult(
      success(
        status({
          failure: {
            code: 4102,
            message: '模型鉴权失败',
            reason: 'modelAccess',
            failureClass: 'modelAuth',
            nextActions: ['checkConnection', 'viewInputSummary'],
            reference: '0123456789ab',
            unverified: true,
            legacy: false
          }
        })
      )
    )
    expect(parsed?.data?.failure).toEqual({
      code: 4102,
      message: '模型鉴权失败',
      reason: 'modelAccess',
      failureClass: 'modelAuth',
      nextActions: ['checkConnection', 'viewInputSummary'],
      reference: '0123456789ab',
      unverified: true,
      legacy: false
    })
    expect(
      parseSceneGenerationStatusResult(
        success(
          status({
            failure: {
              code: 4102,
              message: '模型鉴权失败',
              category: 'auth',
              httpStatus: 401,
              causeName: 'APIError'
            } as never
          })
        )
      )
    ).toBeNull()
    expect(
      parseSceneGenerationStatusResult(
        success(
          status({
            failure: {
              code: 4102,
              message: '模型鉴权失败',
              failureClass: 'rawCategory'
            } as never
          })
        )
      )
    ).toBeNull()
    expect(
      parseSceneGenerationStatusResult(
        success(
          status({
            failure: {
              code: 4102,
              message: '模型鉴权失败',
              nextActions: ['retrySubmit']
            } as never
          })
        )
      )
    ).toBeNull()
  })

  it('接受最近 6 条安全进度，拒绝超过 6 条和内部字段', () => {
    const progress = (sequence: number) => ({
      sequence,
      createdAt: '2026-10-31T12:34:56.789Z',
      stage: 'generating',
      message: 'AI 正在生成候选脚本'
    })
    const parsed = parseSceneGenerationStatusResult(
      success(status({ recentProgress: [1, 2, 3, 4, 5, 6].map(progress) }))
    )
    expect(parsed?.data?.recentProgress).toHaveLength(6)
    expect(
      parseSceneGenerationStatusResult(
        success(status({ recentProgress: [1, 2, 3, 4, 5, 6, 7].map(progress) }))
      )
    ).toBeNull()
    expect(
      parseSceneGenerationStatusResult(
        success({
          ...status({ recentProgress: [progress(1)] }),
          recentProgress: [{ ...progress(1), rawModelText: '原文' }]
        })
      )
    ).toBeNull()
    expect(
      parseSceneGenerationStatusResult(
        success({
          ...status({ recentProgress: [progress(1)] }),
          recentProgress: [{ ...progress(1), filePath: 'D:/secret/start.txt' }]
        })
      )
    ).toBeNull()
  })

  it('历史摘要接受安全失败原因和旧记录标记，拒绝额外内部字段', () => {
    const summary = {
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: 'operation-1',
      threadId: 'thread-1',
      branchId: 'branch-1',
      checkpointId: 'checkpoint-1',
      boundary: 'failed',
      stage: 'failed',
      message: '本次生成未完成',
      createdAt: '2026-11-04T12:34:56.789Z',
      failureReason: 'modelFailure',
      legacy: true
    }
    const parsed = parseSceneGenerationHistoryResult({
      code: ErrorCodes.success,
      msg: '场景历史已读取',
      data: [summary]
    })
    expect(parsed?.data?.[0]).toMatchObject({
      failureReason: 'modelFailure',
      legacy: true
    })
    expect(
      parseSceneGenerationHistoryResult({
        code: ErrorCodes.success,
        msg: '场景历史已读取',
        data: [{ ...summary, category: 'sdk', causeName: 'APIError' }]
      })
    ).toBeNull()
    expect(
      parseSceneGenerationHistoryResult({
        code: ErrorCodes.success,
        msg: '场景历史已读取',
        data: [{ ...summary, failureReason: 'raw reason' }]
      })
    ).toBeNull()
  })
})
