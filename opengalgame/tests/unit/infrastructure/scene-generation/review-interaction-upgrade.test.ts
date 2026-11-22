import { expect, it } from 'vitest'
import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import type { SceneGenerationInteractionVO } from '@application/scene-generation/vo/SceneGenerationVO'
import { restorePhaseTwoReviewInteraction } from '@infrastructure/scene-generation/execution/ReviewInteractionUpgrade'

const checkpointId = 'pi-review-operation-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function executionWith(
  interaction: SceneGenerationInteractionVO,
  checkpoint = interaction.checkpointId
): SceneGenerationExecution {
  return {
    checkpointId: checkpoint,
    interaction
  } as unknown as SceneGenerationExecution
}

function interaction(
  kind: 'review' | 'correction',
  allowedReplies: SceneGenerationInteractionVO['allowedReplies'],
  message: string
): SceneGenerationInteractionVO {
  return {
    interactionId: `interaction-${kind}`,
    checkpointId,
    kind,
    message,
    options: [],
    allowedReplies,
    candidateSnapshotId: 'a'.repeat(40)
  }
}

it('阶段二审阅等待恢复接受/修改/丢弃并移除阶段提示', () => {
  const upgraded = restorePhaseTwoReviewInteraction(
    executionWith(
      interaction(
        'review',
        ['discard'],
        '请审阅当前候选（3 条语句，0 个校验问题）。' +
          '当前构建支持预览与丢弃；接受与修订将在后续阶段启用。'
      )
    )
  )
  expect(upgraded.changed).toBe(true)
  expect(upgraded.execution.interaction).toMatchObject({
    kind: 'review',
    allowedReplies: ['accept', 'revise', 'discard'],
    message: '请审阅当前候选（3 条语句，0 个校验问题）。'
  })
})

it('阶段二修正等待只恢复修改/丢弃，不把接受带给故障态', () => {
  const upgraded = restorePhaseTwoReviewInteraction(
    executionWith(
      interaction(
        'correction',
        ['discard'],
        '候选还不能进入预览。缺少素材\n当前构建仅支持预览与丢弃；修订将在后续阶段启用。'
      )
    )
  )
  expect(upgraded.changed).toBe(true)
  expect(upgraded.execution.interaction?.allowedReplies).toEqual(['revise', 'discard'])
  expect(upgraded.execution.interaction?.allowedReplies).not.toContain('accept')
  expect(upgraded.execution.interaction?.message).toBe('候选还不能进入预览。缺少素材')
})

it('阶段二通过等待补记当前修订，供修改后按原检查点预览', () => {
  const base = executionWith(
    interaction(
      'review',
      ['discard'],
      '请审阅当前候选。当前构建支持预览与丢弃；接受与修订将在后续阶段启用。'
    )
  )
  const execution: SceneGenerationExecution = {
    ...base,
    candidateSnapshotId: 'a'.repeat(40),
    artifactValidation: { issues: [] }
  }
  const upgraded = restorePhaseTwoReviewInteraction(execution)
  expect(upgraded.changed).toBe(true)
  expect(upgraded.execution.publishedCandidates).toEqual([
    {
      candidateSnapshotId: 'a'.repeat(40),
      checkpointId,
      artifactValidation: { issues: [] }
    }
  ])
})

it('非 Pi 审阅边界或已完整动作的记录保持原样', () => {
  const legacy = executionWith(interaction('review', ['discard'], '旧检查点审阅'), 'checkpoint-1')
  const completed = executionWith(
    interaction('review', ['accept', 'revise', 'discard'], '请审阅当前候选。')
  )
  expect(restorePhaseTwoReviewInteraction(legacy)).toEqual({
    execution: legacy,
    changed: false
  })
  expect(restorePhaseTwoReviewInteraction(completed)).toEqual({
    execution: completed,
    changed: false
  })
})
