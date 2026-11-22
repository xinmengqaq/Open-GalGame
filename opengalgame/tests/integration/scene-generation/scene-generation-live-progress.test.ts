import { expect, it, vi } from 'vitest'
import {
  createSceneGenerationFixture,
  generationRequest
} from '../../unit/application/scene-generation/sceneGenerationFixture'
import type { SceneGenerationWorkflowProgress } from '@application/scene-generation/models/SceneGenerationExecution'
import {
  generationFixture,
  request
} from '../../../../harness/acceptance/support/generationFixture'

it('终态写入后迟到的进度发布不改变 step、live 和 budget', async () => {
  const fixture = createSceneGenerationFixture()
  let publishProgress: ((progress: SceneGenerationWorkflowProgress) => Promise<unknown>) | undefined
  fixture.workflow.executeGeneration.mockImplementationOnce(async (runtime) => {
    publishProgress = runtime.publishProgress
    return new Promise(() => undefined)
  })
  await fixture.service.generateScene(generationRequest)
  const running = fixture.runNext()
  await vi.waitFor(() => {
    expect(publishProgress).toBeTypeOf('function')
  })
  const active = fixture.coordinator.activeExecutions.get(
    JSON.stringify(['project-1', 'scene-1', 'operation-1'])
  )
  if (!active || !publishProgress) throw new Error('执行槽和进度回调应当已建立')
  active.controller.abort()
  const recovering = fixture.coordinator.recoverFailure(
    active,
    new Error('场景生成已取消'),
    true,
    false
  )
  await vi.waitFor(() => {
    expect(fixture.executions.get('operation-1')?.state).toBe('cancelled')
  })
  const settled = fixture.executions.get('operation-1')
  const publishing = publishProgress({
    step: 'generating',
    attempt: 1,
    budget: { correctionsUsed: 0, modelCallsUsed: 9, toolCallsUsed: 4, activeElapsedMs: 20 },
    live: { activity: 'waitingModel', lastActivityAt: '2026-10-29T00:00:00.000Z' }
  })
  await recovering
  await publishing
  const recorded = fixture.executions.get('operation-1')
  expect(recorded?.state).toBe('cancelled')
  expect(recorded?.step).toBeUndefined()
  expect(recorded?.live).toBeUndefined()
  expect(recorded?.budget.modelCallsUsed).toBe(settled?.budget.modelCallsUsed)
  expect(recorded?.budget.toolCallsUsed).toBe(settled?.budget.toolCallsUsed)
  expect(recorded?.budget.activeElapsedMs).toBe(settled?.budget.activeElapsedMs)
  void running
})

it('真实生成发布生成中与等待审阅阶段，结束后不再发布', async () => {
  const f = await generationFixture()
  await f.app.generation.generateScene(request)
  await f.run()
  const phases = f.progress.map((event) => event.phase)
  expect(phases).toContain('generating')
  expect(phases.at(-1)).toBe('waiting')
  const count = f.progress.length
  await f.app.generation.resumeSceneGeneration(request)
  expect(f.progress).toHaveLength(count)
}, 30000)
