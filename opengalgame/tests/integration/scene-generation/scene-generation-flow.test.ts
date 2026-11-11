import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createSceneGeneration } from '@bootstrap/sceneGeneration'
import {
  generationFixture,
  request,
  validScript
} from '../../../../harness/acceptance/support/generationFixture'

it('真实文件工具写脚本、存候选并提交真实文件', async () => {
  const f = await generationFixture()
  await f.app.generation.generateScene(request)
  await f.run()
  const status = await f.app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('succeeded')
  expect(await readFile(join(f.projectRoot, 'game/scene/start.txt'), 'utf8')).toBe(validScript)
  expect(f.git('rev-parse', 'HEAD')).toBe(status.result?.commitId)
  expect(status.result?.preview.assetLocations).toContainEqual(
    expect.objectContaining({
      assetId: 'station',
      relativePath: 'assets/background/station.svg',
      sequence: 0
    })
  )
  expect(status.result?.preview.validationReport.issues).toEqual([])
  const first = JSON.stringify(f.bodies[0].messages)
  expect(first).toContain('[运行状态]')
  expect(first).toContain('阶段：撰写候选')
  expect(f.bodies[0].tools.map((tool) => tool.function.name)).not.toContain('read_file')
  const execution = await f.app.ports.executions.readExecution(request)
  expect(execution?.candidateSnapshotId).toMatch(/^[a-f0-9]{40}$/)
  const count = f.bodies.length
  await f.app.generation.resumeSceneGeneration(request)
  expect(f.bodies).toHaveLength(count)
})

it('真实缺失引用触发同一智能体 repair，保留剧情后重新读取及提交', async () => {
  const f = await generationFixture({ repair: true })
  await f.app.generation.generateScene(request)
  await f.run()
  expect((await f.app.status.getSceneGenerationStatus(request)).state).toBe('succeeded')
  expect(f.writes()).toBe(2)
  expect(
    f.bodies.some(
      (body) =>
        JSON.stringify(body.messages).includes('repair') &&
        JSON.stringify(body.messages).includes('missing')
    )
  ).toBe(true)
  expect(await readFile(join(f.projectRoot, 'game/scene/start.txt'), 'utf8')).toBe(validScript)
})

it('等待重启后接受回复，回复先保存且重复接受不重复模型或正式提交', async () => {
  const f = await generationFixture()
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const waiting = await f.app.status.getSceneGenerationStatus(request)
  expect(waiting.state).toBe('waiting')
  const restarted = await createSceneGeneration(f.config)
  const reply = {
    projectId: waiting.projectId,
    sceneId: waiting.sceneId,
    operationId: waiting.operationId,
    threadId: waiting.threadId,
    branchId: waiting.branchId,
    interactionId: waiting.interaction!.interactionId,
    checkpointId: waiting.interaction!.checkpointId,
    candidateSnapshotId: waiting.interaction!.candidateSnapshotId,
    replyId: 'reply-1',
    reply: { kind: 'accept' as const }
  }
  await restarted.generation.replySceneGenerationInteraction(reply)
  expect((await restarted.ports.executions.readExecution(request))?.pendingReply?.replyId).toBe(
    'reply-1'
  )
  const count = f.bodies.length
  await f.run()
  expect((await restarted.status.getSceneGenerationStatus(request)).state).toBe('succeeded')
  await restarted.generation.replySceneGenerationInteraction(reply)
  expect(f.bodies).toHaveLength(count)
})
