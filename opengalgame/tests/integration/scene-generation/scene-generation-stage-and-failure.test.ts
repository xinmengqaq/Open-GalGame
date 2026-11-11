import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createSceneGeneration } from '@bootstrap/sceneGeneration'
import { createWebGalGenerationGraph } from '@infrastructure/scene-generation/workflow/createWebGalGenerationGraph'
import { WebGalGenerationCheckpointSaver } from '@infrastructure/scene-generation/history/WebGalGenerationCheckpoint'
import { langGraphThreadKey } from '@infrastructure/workflow/WorkflowIdentity'
import {
  generationFixture,
  request,
  validScript
} from '../../../../harness/acceptance/support/generationFixture'
import type { SceneGenerationReplyDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import type { SceneGenerationStatusVO } from '@application/scene-generation/vo/SceneGenerationVO'

function boundReply(
  source: SceneGenerationStatusVO | SceneGenerationExecution,
  replyId: string,
  reply: SceneGenerationReplyDTO
) {
  const interaction = source.interaction
  if (!interaction) throw new Error('没有可回复的等待')
  return {
    projectId: source.projectId,
    sceneId: source.sceneId,
    operationId: source.operationId,
    threadId: source.threadId,
    branchId: source.branchId,
    interactionId: interaction.interactionId,
    checkpointId: interaction.checkpointId,
    candidateSnapshotId: interaction.candidateSnapshotId,
    replyId,
    reply
  }
}

it.each([
  ['林:你好。;\nsay:旁白。;', 'implicit-speaker'],
  ['say:旁白。 -speaker=;', 'implicit-speaker'],
  ['林:你好;\nsay:旁白 -clear=FALSE;', 'implicit-speaker'],
  ['林:你好;\nsay:旁白 -clear= FALSE ;', 'implicit-speaker'],
  ['林:你好;\nsay:旁白 -clear={kept};', 'implicit-speaker'],
  ['playEffect:bell.ogg;\nbgm:none;\nend;', 'automatic-effect-before-end'],
  ['playEffect:bell.ogg;\nsay:等待。 -clear -when=false;\nend;', 'automatic-effect-before-end'],
  ['playEffect:bell.ogg;\njumpLabel:finish;\nlabel:finish;\nend;', 'automatic-effect-before-end'],
  [
    'playEffect:bell.ogg;\njumpLabel:finish;\nsay:不会执行。 -clear;\nlabel:finish;\nend;',
    'automatic-effect-before-end'
  ],
  ['playEffect:bell.ogg;\nsay:等待 -clear -next= TRUE ;\nend;', 'automatic-effect-before-end']
])('真实解析保留舞台事实并定位问题：%s', async (script, code) => {
  const f = await generationFixture()
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const execution = (await f.app.ports.executions.readExecution(request))!
  const revision = await f.app.ports.artifacts.writeCandidateFiles(execution, {
    ...request,
    candidateSnapshotId: execution.candidateSnapshotId!,
    files: [{ relativePath: 'game/scene/start.txt', content: script }]
  })
  const candidate = await f.app.ports.artifacts.readCandidate(
    execution,
    revision.candidateSnapshotId
  )
  expect(candidate.preview.validationReport.issues).toContainEqual(
    expect.objectContaining({ code })
  )
})

it.each([
  'playEffect:bell.ogg;\nsay:等待 -clear -next=FALSE;\nend;',
  'playEffect:bell.ogg;\nsay:等待 -clear -next= FALSE ;\nend;',
  'playEffect:bell.ogg;\nsay:等待 -clear -next={auto};\nend;',
  'playEffect:bell.ogg -when=false;\nend;',
  'playEffect:bell.ogg;\nend: -when=false;\nsay:等玩家。 -clear;\nend;',
  'jumpLabel:finish;\nplayEffect:bell.ogg;\nlabel:finish;\nend;'
])('不会把未执行的音效或结束当成调度问题：%s', async (script) => {
  const f = await generationFixture()
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const execution = (await f.app.ports.executions.readExecution(request))!
  const revision = await f.app.ports.artifacts.writeCandidateFiles(execution, {
    ...request,
    candidateSnapshotId: execution.candidateSnapshotId!,
    files: [{ relativePath: 'game/scene/start.txt', content: script }]
  })
  const candidate = await f.app.ports.artifacts.readCandidate(
    execution,
    revision.candidateSnapshotId
  )
  expect(candidate.preview.validationReport.issues.map((issue) => issue.code)).not.toContain(
    'automatic-effect-before-end'
  )
})

it.each([
  'changeBg:station.svg -when=false;\n林:第一句。;\n林:第二句。;',
  'jumpLabel:later;\nchangeBg:station.svg;\nlabel:later;\n林:第一句。;\n林:第二句。;'
])('未执行到的背景不能补上后面的连续对白：%s', async (script) => {
  const f = await generationFixture()
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const execution = (await f.app.ports.executions.readExecution(request))!
  const revision = await f.app.ports.artifacts.writeCandidateFiles(execution, {
    ...request,
    candidateSnapshotId: execution.candidateSnapshotId!,
    files: [{ relativePath: 'game/scene/start.txt', content: script }]
  })
  const candidate = await f.app.ports.artifacts.readCandidate(
    execution,
    revision.candidateSnapshotId
  )
  expect(candidate.preview.validationReport.issues).toContainEqual(
    expect.objectContaining({ code: 'missing-background' })
  )
})

it('执行到的背景仍能满足后面的连续对白', async () => {
  const f = await generationFixture()
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const execution = (await f.app.ports.executions.readExecution(request))!
  const revision = await f.app.ports.artifacts.writeCandidateFiles(execution, {
    ...request,
    candidateSnapshotId: execution.candidateSnapshotId!,
    files: [
      {
        relativePath: 'game/scene/start.txt',
        content: 'changeBg:station.svg;\n林:第一句。;\n林:第二句。;'
      }
    ]
  })
  const candidate = await f.app.ports.artifacts.readCandidate(
    execution,
    revision.candidateSnapshotId
  )
  expect(candidate.preview.validationReport.issues.map((issue) => issue.code)).not.toContain(
    'missing-background'
  )
})

it('未执行的解析和播放说明不阻断合格候选', async () => {
  const f = await generationFixture({ tradeoffs: ['未执行播放验证；解析由工作流执行。'] })
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const status = await f.app.status.getSceneGenerationStatus(request)
  expect(status.interaction?.kind).toBe('review')
  expect(f.writes()).toBe(1)
})

it.each([true, false])(
  '说明不阻断审阅后进入新的审阅而不提交，reviewCandidate=%s',
  async (reviewCandidate) => {
    const f = await generationFixture({ unresolved: true })
    await f.app.generation.generateScene({ ...request, reviewCandidate })
    await f.run()
    const waiting = await f.app.status.getSceneGenerationStatus(request)
    const previous = (await f.app.ports.executions.readExecution(request))!
    const count = f.bodies.length
    const restarted = await createSceneGeneration(f.config)
    const option = waiting.interaction!.options.find((item) => item.id === 'reviewCandidate')
    expect(option).toBeDefined()
    await restarted.generation.replySceneGenerationInteraction(
      boundReply(waiting, 'explanation-only', { kind: 'select', optionId: option!.id })
    )
    await f.run()
    const status = await restarted.status.getSceneGenerationStatus(request)
    const current = (await restarted.ports.executions.readExecution(request))!
    expect(status.interaction?.kind).toBe('review')
    expect(status.interaction?.interactionId).not.toBe(waiting.interaction?.interactionId)
    expect(current.candidateSnapshotId).toBe(previous.candidateSnapshotId)
    expect(current.budget.modelCallsUsed).toBe(previous.budget.modelCallsUsed)
    expect(f.bodies).toHaveLength(count)
    expect(f.writes()).toBe(1)
    expect(f.git('rev-list', '--count', 'HEAD')).toBe('1')
    await restarted.generation.replySceneGenerationInteraction(
      boundReply(status, 'review-accepted', { kind: 'accept' })
    )
    await f.run()
    expect((await restarted.status.getSceneGenerationStatus(request)).state).toBe('succeeded')
  }
)

it('说明不阻断后的修正仍等待接受，不直接提交', async () => {
  const f = await generationFixture({ unresolved: true })
  await f.app.generation.generateScene({ ...request, reviewCandidate: false })
  await f.run()
  const waiting = await f.app.status.getSceneGenerationStatus(request)
  const option = waiting.interaction!.options.find((item) => item.id === 'reviewCandidate')
  await f.app.generation.replySceneGenerationInteraction(
    boundReply(waiting, 'explanation-only', { kind: 'select', optionId: option!.id })
  )
  await f.run()
  const review = await f.app.status.getSceneGenerationStatus(request)
  const reviewed = (await f.app.ports.executions.readExecution(request))!
  expect(review.interaction?.kind).toBe('review')
  await f.app.generation.replySceneGenerationInteraction(
    boundReply(review, 'review-revise', { kind: 'revise', body: '把道别再写短一些。' })
  )
  await f.run()
  const after = await f.app.status.getSceneGenerationStatus(request)
  const current = (await f.app.ports.executions.readExecution(request))!
  expect(after.state).toBe('waiting')
  expect(after.interaction?.kind).toBe('review')
  expect(after.interaction?.interactionId).not.toBe(review.interaction?.interactionId)
  expect(current.candidateSnapshotId).not.toBe(reviewed.candidateSnapshotId)
  expect(f.git('rev-list', '--count', 'HEAD')).toBe('1')
  await f.app.generation.replySceneGenerationInteraction(
    boundReply(after, 'review-accepted', { kind: 'accept' })
  )
  await f.run()
  expect((await f.app.status.getSceneGenerationStatus(request)).state).toBe('succeeded')
  expect(f.git('rev-list', '--count', 'HEAD')).toBe('2')
})

it('澄清后的修正进入审阅，未经接受不提交正式作品', async () => {
  const f = await generationFixture({ unresolved: true })
  const baseline = f.git('rev-parse', 'HEAD')
  await f.app.generation.generateScene({
    ...request,
    reviewCandidate: true
  })
  await f.run()
  const waiting = await f.app.status.getSceneGenerationStatus(request)
  expect(waiting.state).toBe('waiting')
  expect(waiting.interaction?.kind).toBe('clarification')
  const previous = (await f.app.ports.executions.readExecution(request))!
  await f.app.generation.replySceneGenerationInteraction(
    boundReply(waiting, 'creative-change', {
      kind: 'clarify',
      body: '需要修改剧情，补充告别后的去向。'
    })
  )
  await f.run()
  const status = await f.app.status.getSceneGenerationStatus(request)
  const current = (await f.app.ports.executions.readExecution(request))!
  expect(status.state).toBe('waiting')
  expect(status.interaction?.kind).toBe('review')
  expect(status.interaction?.allowedReplies).toContain('accept')
  expect(current.budget.modelCallsUsed).toBeGreaterThan(previous.budget.modelCallsUsed)
  expect(current.budget.toolCallsUsed).toBeGreaterThan(previous.budget.toolCallsUsed)
  expect(status.candidateSnapshotId).toBeTruthy()
  expect(status.candidateSnapshotId).not.toBe(previous.candidateSnapshotId)
  expect(status.checkpointId).toBe(current.checkpointId)
  expect(status.checkpointId).not.toBe(previous.checkpointId)
  expect(status.result).toBeUndefined()
  const view = await f.app.history.readSceneGenerationCheckpoint({
    ...current,
    checkpointId: current.checkpointId!
  })
  expect(view.canView).toBe(true)
  expect(view.canContinue).toBe(true)
  const stateRoot = join(f.config.userStateRoot, 'ai')
  const graph = createWebGalGenerationGraph({
    stateRoot,
    saver: new WebGalGenerationCheckpointSaver(stateRoot),
    artifacts: f.app.ports.artifacts
  })
  const snapshot = await graph.getState({
    configurable: { thread_id: langGraphThreadKey(current) }
  })
  expect(snapshot.values.execution.budget).toMatchObject({
    correctionsUsed: current.budget.correctionsUsed,
    modelCallsUsed: current.budget.modelCallsUsed,
    toolCallsUsed: current.budget.toolCallsUsed
  })
  expect(snapshot.values.status).toBe('waiting')
  expect(f.git('rev-parse', 'HEAD')).toBe(baseline)
  expect(f.git('rev-list', '--count', 'HEAD')).toBe('1')
  expect(await readFile(join(f.projectRoot, 'game/scene/start.txt'), 'utf8')).toBe('say:原稿;')
  expect(JSON.stringify(status)).not.toContain('test-secret')
  expect(JSON.stringify(status)).not.toContain('rootDirectory')
  expect(validScript).toContain('-clear')
})

it('写出后读改两轮仍能提交候选', async () => {
  const f = await generationFixture({ postWriteResponses: 2 })
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const status = await f.app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('waiting')
  expect(status.candidateSnapshotId).toBeTruthy()
  const channel = structuredChannel(f.bodies[0]!)
  expect(f.bodies.some((body) => JSON.stringify(body).includes('候选已经写出'))).toBe(false)
  expect(f.bodies.some((body) => JSON.stringify(body).includes(channel))).toBe(true)
})

it('重复读取和从不写入都按完成契约停止', async () => {
  const repeated = await generationFixture({ repeatReadBeforeWrite: 7 })
  await repeated.app.generation.generateScene(request)
  // 重复读取后先进入一次收尾提交；没有候选时按无进展失败，不产生候选或交互。
  await expect(repeated.run()).rejects.toThrow(/实际候选脚本写入不一致/)
  const repeatedExecution = (await repeated.app.ports.executions.readExecution(request))!
  const repeatedStatus = await repeated.app.status.getSceneGenerationStatus(request)
  expect(repeated.writes()).toBe(0)
  expect(repeatedExecution.candidateSnapshotId).toBeUndefined()
  expect(repeatedStatus.state).toBe('failed')
  expect(repeatedStatus.failure?.code).toBe(4103)
  expect(repeatedStatus.failure?.reason).not.toBe('outputTruncated')
  expect(repeatedStatus.interaction).toBeUndefined()
  expect(repeated.bodies.length).toBeGreaterThan(0)
  expect(repeated.bodies.length).toBeLessThan(12)

  const never = await generationFixture({ neverWrite: true })
  await never.app.generation.generateScene(request)
  await expect(never.run()).rejects.toThrow(/实际候选脚本写入不一致/)
  expect(never.writes()).toBe(0)
  const failed = await never.app.status.getSceneGenerationStatus(request)
  expect(failed.state).toBe('failed')
  expect(failed.failure?.code).toBe(4103)
  expect(failed.candidateSnapshotId).toBeUndefined()
})

it('非法结构化参数重试有界，不能假装完成', async () => {
  const f = await generationFixture({ invalidStructuredRetries: 6 })
  await f.app.generation.generateScene(request)
  await f.run()
  const status = await f.app.status.getSceneGenerationStatus(request)
  const execution = (await f.app.ports.executions.readExecution(request))!
  expect(status.state).toBe('waiting')
  expect(status.interaction?.kind).toBe('review')
  expect(status.interaction?.allowedReplies).toEqual(['accept', 'revise', 'discard'])
  expect(status.interaction?.message).toContain('完成摘要未生成，请核对创作取舍')
  const stateRoot = join(f.config.userStateRoot, 'ai')
  const graph = createWebGalGenerationGraph({
    stateRoot,
    saver: new WebGalGenerationCheckpointSaver(stateRoot),
    artifacts: f.app.ports.artifacts
  })
  const snapshot = await graph.getState({
    configurable: { thread_id: langGraphThreadKey(execution) }
  })
  expect(snapshot.values.summaryDegraded).toBe(true)
  expect(snapshot.values.status).toBe('waiting')
  expect(f.bodies.length).toBeLessThan(12)
  expect(f.bodies.length).toBeGreaterThan(1)
  const channel = structuredChannel(f.bodies[0]!)
  expect(channel).toBeTruthy()
  expect(['read_file', 'writeText', 'replaceText', 'readTextRange', 'listDirectory']).not.toContain(
    channel
  )
  expect(f.git('rev-list', '--count', 'HEAD')).toBe('1')
})

function structuredChannel(body: {
  tools: Array<{ function: { name: string } }>
  response_format?: { type?: string }
}): string {
  if (body.response_format?.type === 'json_schema' || body.response_format?.type === 'json_object')
    return body.response_format.type
  const name = body.tools.find(
    (tool) =>
      !['read_file', 'writeText', 'replaceText', 'readTextRange', 'listDirectory'].includes(
        tool.function.name
      )
  )?.function.name
  if (!name) throw new Error('首次请求没有结构化通道')
  return name
}
