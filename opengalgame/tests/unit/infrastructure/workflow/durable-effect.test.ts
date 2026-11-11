import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  abandonDurableEffect,
  decideDurableEffectRecovery,
  readDurableEffects,
  settleStartedDurableEffects,
  writeDurableEffect
} from '@infrastructure/workflow/execution/durableEffect'
import type { DurableEffectRecord } from '@infrastructure/workflow/DurableEffectRecord'
import { ErrorCodes } from '@common/errors/ErrorCodes'

import { identity, removeTemporaryDirectories, temporaryDirectory } from './workflowFixture'

const completed: DurableEffectRecord = {
  operationId: 'operation-a',
  stepId: 'write-scene',
  inputDigest: 'input-1',
  resultDigest: 'result-1',
  candidateRevision: 'abc1234',
  status: 'completed',
  kind: 'fileWrite'
}

afterEach(async () => {
  await removeTemporaryDirectories()
})

describe('可恢复副作用', () => {
  it('已完成且结果可靠时不重复执行，也不再核对', () => {
    const verify = vi.fn()

    expect(decideDurableEffectRecovery(completed, verify)).toEqual({
      action: 'skip',
      resultDigest: 'result-1',
      candidateRevision: 'abc1234'
    })
    expect(verify).not.toHaveBeenCalled()
  })

  it('结果不明时先核对，仍然不明就停止恢复并保留原因', () => {
    const verify = vi.fn(() => ({ outcome: 'unknown' as const }))

    expect(
      decideDurableEffectRecovery(
        { ...completed, status: 'unknown', resultDigest: undefined },
        verify
      )
    ).toEqual({ action: 'stop', reason: '副作用结果不明，已停止恢复' })
    expect(verify).toHaveBeenCalledOnce()
  })

  it('核对确认没有发生时才允许执行一次，确认已发生时不重放', () => {
    const started: DurableEffectRecord = {
      ...completed,
      status: 'started',
      resultDigest: undefined,
      candidateRevision: undefined
    }

    expect(decideDurableEffectRecovery(started, () => ({ outcome: 'absent' }))).toEqual({
      action: 'execute'
    })
    expect(
      decideDurableEffectRecovery(started, () => ({
        outcome: 'confirmed',
        resultDigest: 'seen',
        candidateRevision: 'abc1234'
      }))
    ).toEqual({ action: 'skip', resultDigest: 'seen', candidateRevision: 'abc1234' })
  })

  it('题组字段缺失时仍可读取，形状非法时拒绝读取', async () => {
    const scope = identity()
    const stateRoot = await temporaryDirectory()
    const path = join(
      stateRoot,
      'projects',
      scope.projectId,
      'threads',
      scope.threadId,
      'operations',
      scope.operationId,
      'effects',
      `${completed.stepId}.json`
    )
    await writeDurableEffect(stateRoot, scope, completed)
    const stored = await readDurableEffects(stateRoot, scope)
    expect(stored).toEqual([completed])
    expect(stored[0]).not.toHaveProperty('questions')

    const option = (id: string) => ({ id, label: '选项', description: '说明' })
    const question = (questionId: string, optionIds: readonly string[]) => ({
      questionId,
      prompt: '题干',
      options: optionIds.map((id) => option(id))
    })
    const invalid = [
      { unexpected: true },
      [1, 2, 3, 4, 5].map((index) => question(`q${index}`, ['o1', 'o2', 'o3'])),
      [question('q1', ['o1', 'o2'])],
      [question('', ['o1', 'o2', 'o3'])],
      [question('q1', ['o1', '', 'o3'])],
      [question('q1', ['o1', 'o2', 'o3']), question('q1', ['o4', 'o5', 'o6'])],
      [question('q1', ['o1', 'o1', 'o2'])]
    ]
    const original = await readFile(path, 'utf8')
    for (const questions of invalid) {
      const effect = JSON.parse(original) as DurableEffectRecord & { questions?: unknown }
      effect.questions = questions
      await writeFile(path, JSON.stringify(effect))
      await expect(readDurableEffects(stateRoot, scope)).rejects.toMatchObject({
        category: 'recoveryBasisMissing',
        message: '缺少可恢复依据'
      })
    }
  })

  it('失败状态可读写，只把当前操作的已开始记录标为失败', async () => {
    const scope = identity()
    const other = identity({ operationId: 'operation-b' })
    const stateRoot = await temporaryDirectory()
    const started: DurableEffectRecord = {
      operationId: scope.operationId,
      stepId: 'generate-0-initial',
      inputDigest: 'input-started',
      status: 'started',
      kind: 'fileWrite'
    }
    const unknown: DurableEffectRecord = {
      ...started,
      stepId: 'generate-1-initial',
      inputDigest: 'input-unknown',
      status: 'unknown'
    }
    const failed: DurableEffectRecord = {
      ...started,
      stepId: 'generate-2-initial',
      inputDigest: 'input-failed',
      candidateRevision: 'abc1234',
      status: 'failed'
    }
    const otherStarted: DurableEffectRecord = {
      ...started,
      operationId: other.operationId,
      stepId: 'other-step'
    }
    await writeDurableEffect(stateRoot, scope, started)
    await writeDurableEffect(stateRoot, scope, { ...completed, operationId: scope.operationId })
    await writeDurableEffect(stateRoot, scope, unknown)
    await writeDurableEffect(stateRoot, scope, failed)
    await writeDurableEffect(stateRoot, other, otherStarted)

    await settleStartedDurableEffects(stateRoot, scope)
    await settleStartedDurableEffects(stateRoot, scope)

    const stored = await readDurableEffects(stateRoot, scope)
    expect(stored).toEqual(
      expect.arrayContaining([
        { ...started, status: 'failed' },
        { ...completed, operationId: scope.operationId },
        unknown,
        failed
      ])
    )
    expect(stored).toHaveLength(4)
    expect(stored.find((effect) => effect.stepId === started.stepId)).not.toHaveProperty(
      'resultDigest'
    )
    expect(await readDurableEffects(stateRoot, other)).toEqual([otherStarted])
  })

  it('放弃副作用要求操作、步骤和输入摘要与记录一致', async () => {
    const scope = identity()
    const stateRoot = await temporaryDirectory()
    const started: DurableEffectRecord = {
      operationId: scope.operationId,
      stepId: 'generate-0-initial',
      inputDigest: 'input-started',
      status: 'started',
      kind: 'fileWrite'
    }
    const path = join(
      stateRoot,
      'projects',
      scope.projectId,
      'threads',
      scope.threadId,
      'operations',
      scope.operationId,
      'effects',
      `${started.stepId}.json`
    )
    await writeDurableEffect(stateRoot, scope, started)

    await expect(
      abandonDurableEffect(stateRoot, scope, started.stepId, 'other-input')
    ).rejects.toMatchObject({ code: ErrorCodes.invalidRequest })
    expect(await readDurableEffects(stateRoot, scope)).toEqual([started])

    await writeFile(path, JSON.stringify({ ...started, operationId: 'operation-b' }))
    await expect(
      abandonDurableEffect(stateRoot, scope, started.stepId, started.inputDigest)
    ).rejects.toMatchObject({ code: ErrorCodes.invalidRequest })

    await writeFile(path, JSON.stringify({ ...started, stepId: 'other-step' }))
    await expect(
      abandonDurableEffect(stateRoot, scope, started.stepId, started.inputDigest)
    ).rejects.toMatchObject({ code: ErrorCodes.invalidRequest })

    await writeFile(path, JSON.stringify(started))
    await abandonDurableEffect(stateRoot, scope, started.stepId, started.inputDigest)
    expect(await readDurableEffects(stateRoot, scope)).toEqual([])
  })
})
