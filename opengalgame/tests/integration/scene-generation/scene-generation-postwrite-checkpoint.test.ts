import { expect, it, vi } from 'vitest'
import {
  generationFixture,
  request
} from '../../../../harness/acceptance/support/generationFixture'

it('写后候选读取中断时保留可继续的 step=reading 检查点', async () => {
  const f = await generationFixture()
  const operation = await f.app.generation.generateScene(request)
  f.jobs.shift()
  let execution = (await f.app.ports.executions.readExecution(request))!
  const workspace = await f.app.ports.workspace.createWorkspace(execution)
  execution = { ...execution, workspace }
  await f.app.ports.executions.writeExecution(execution)
  const read = vi
    .spyOn(f.app.ports.artifacts, 'readCandidate')
    .mockRejectedValueOnce(new Error('simulated process interruption at read'))
  await expect(
    f.app.ports.workflow.executeGeneration({
      execution,
      signal: new AbortController().signal,
      userAbortSignal: new AbortController().signal,
      activeTimeoutSignal: new AbortController().signal,
      publishProgress: async (progress) => {
        execution = { ...execution, ...progress }
        await f.app.ports.executions.writeExecution(execution)
        return structuredClone(execution)
      },
      recordCandidateRevision: async (revision) => {
        execution = { ...execution, candidateSnapshotId: revision.candidateSnapshotId }
        await f.app.ports.executions.writeExecution(execution)
        return structuredClone(execution)
      },
      recordFailure: async (failure) => {
        execution = { ...execution, failure }
        await f.app.ports.executions.writeExecution(execution)
        return structuredClone(execution)
      }
    })
  ).rejects.toThrow()
  read.mockRestore()
  const history = await f.app.history.listSceneGenerationHistory({
    ...operation,
    limit: 20
  })
  const checkpoint = history.checkpoints.find(
    (item) => item.canContinue && item.phase === 'reading'
  )
  expect(checkpoint).toBeDefined()
  expect(checkpoint?.phase).toBe('reading')
  expect(checkpoint?.canContinue).toBe(true)
})
