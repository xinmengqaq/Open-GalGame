import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createSceneGeneration } from '@bootstrap/sceneGeneration'
import { OpenSceneGenerationCandidatePreviewUseCase } from '@application/scene-generation/services/impl/OpenSceneGenerationCandidatePreviewUseCase'
import {
  readDurableEffects,
  writeDurableEffect
} from '@infrastructure/workflow/execution/durableEffect'
import {
  generationFixture,
  request,
  validScript
} from '../../../../harness/acceptance/support/generationFixture'
import { clarificationAnswerFixture } from './scene-generation-clarification-fixture'

const entryPath = 'game/scene/start.txt'

/** 写前题组：真实 requestClarification 工具调用需要至少一题三选项。 */
const clarificationQuestions = [
  {
    prompt: '开场停在哪个动作？',
    detail: '决定候选的第一句演出',
    options: [
      { label: '推门', description: '直接进入场景' },
      { label: '停顿', description: '保留犹豫' },
      { label: '沉默', description: '收在静止画面' }
    ]
  }
]

/** OpenAI-compatible 请求可能把文本包成内容块；只拼接文本块。 */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((block) => {
      if (!block || typeof block !== 'object' || !('text' in block)) return []
      return typeof block.text === 'string' ? [block.text] : []
    })
    .join('')
}

it('真实 Pi 工具循环写脚本、经宿主校验并发布待审阅候选', async () => {
  const f = await generationFixture()
  const baselineCommit = f.git('rev-parse', 'HEAD')
  await f.app.generation.generateScene(request)
  await f.run()
  const status = await f.app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('waiting')
  expect(status.interaction).toMatchObject({
    kind: 'review',
    allowedReplies: ['accept', 'revise', 'discard']
  })
  expect(status.interaction?.message).not.toContain('当前构建')
  expect(status.candidateSnapshotId).toMatch(/^[a-f0-9]{40}$/)
  expect(status.checkpointId).toMatch(/^pi-review-/)
  const execution = await f.app.ports.executions.readExecution(request)
  expect(execution?.artifactValidation?.issues).toEqual([])
  expect(await readFile(join(f.projectRoot, entryPath), 'utf8')).toBe('say:原稿;')
  expect(f.git('rev-parse', 'HEAD')).toBe(baselineCommit)

  expect(execution?.candidateSnapshotId).toBe(status.candidateSnapshotId)
  const candidate = await f.app.ports.artifacts.readCandidate(
    execution!,
    status.candidateSnapshotId!
  )
  expect(candidate.preview.validationReport.issues).toEqual([])
  expect(candidate.preview.assetLocations).toContainEqual(
    expect.objectContaining({
      assetId: 'station',
      relativePath: 'assets/background/station.svg',
      sequence: 0
    })
  )
  const facts = JSON.stringify(f.bodies[0].messages)
  expect(facts).toContain('generate')
  expect(facts).toContain('draft')
  expect(f.bodies[0].tools.map((tool) => tool.function.name)).toEqual(
    expect.arrayContaining(['listDirectory', 'readTextRange', 'writeCandidate'])
  )
  expect(f.bodies[0].tools.map((tool) => tool.function.name)).not.toContain('read_file')

  const count = f.bodies.length
  await f.app.generation.resumeSceneGeneration(request)
  expect(f.bodies).toHaveLength(count)
})

it('未要求审阅的普通生成也先等作者接受，接受前不改正式作品且只提交一次', async () => {
  const f = await generationFixture()
  const baselineCommit = f.git('rev-parse', 'HEAD')
  await f.app.generation.generateScene(request)
  await f.run()
  const waiting = await f.app.status.getSceneGenerationStatus(request)
  expect(waiting.state).toBe('waiting')
  expect(waiting.interaction).toMatchObject({
    kind: 'review',
    allowedReplies: ['accept', 'revise', 'discard']
  })
  expect(waiting.candidateSnapshotId).toMatch(/^[a-f0-9]{40}$/)
  const execution = await f.app.ports.executions.readExecution(request)
  expect(execution?.reviewCandidate).toBe(false)
  expect(await readFile(join(f.projectRoot, entryPath), 'utf8')).toBe('say:原稿;')
  expect(f.git('rev-parse', 'HEAD')).toBe(baselineCommit)

  const reply = {
    projectId: waiting.projectId,
    sceneId: waiting.sceneId,
    operationId: waiting.operationId,
    threadId: waiting.threadId,
    branchId: waiting.branchId,
    interactionId: waiting.interaction!.interactionId,
    checkpointId: waiting.interaction!.checkpointId,
    candidateSnapshotId: waiting.interaction!.candidateSnapshotId,
    replyId: 'reply-accept-default-review',
    reply: { kind: 'accept' as const }
  }
  await f.app.generation.replySceneGenerationInteraction(reply)
  // 回复已持久接受，但正式作品仍要经既有提交网关才变更。
  expect(await readFile(join(f.projectRoot, entryPath), 'utf8')).toBe('say:原稿;')
  expect(f.git('rev-parse', 'HEAD')).toBe(baselineCommit)

  const count = f.bodies.length
  await f.run()
  const finished = await f.app.status.getSceneGenerationStatus(request)
  expect(finished.state).toBe('succeeded')
  expect(finished.result?.commitId).toBeTruthy()
  expect(f.bodies).toHaveLength(count)
  expect(await readFile(join(f.projectRoot, entryPath), 'utf8')).toBe(validScript)
  expect(f.git('rev-parse', 'HEAD')).toBe(finished.result?.commitId)

  await f.app.generation.replySceneGenerationInteraction(reply)
  expect(f.bodies).toHaveLength(count)
  expect(f.git('rev-parse', 'HEAD')).toBe(finished.result?.commitId)
})

it('缺失引用触发自动修正，保留剧情后重新校验并通过', async () => {
  const f = await generationFixture({ repair: true })
  const baselineCommit = f.git('rev-parse', 'HEAD')
  await f.app.generation.generateScene(request)
  await f.run()
  const status = await f.app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('waiting')
  expect(status.interaction?.kind).toBe('review')
  expect(f.writes()).toBe(2)
  expect(
    f.bodies.some((body) => {
      const messages = JSON.stringify(body.messages)
      return messages.includes('repair') && messages.includes('missing-asset')
    })
  ).toBe(true)
  const repairFacts = f.bodies
    .flatMap((body) => body.messages.map((message) => messageText(message.content)))
    .find((content) => content.includes('"mode":"repair"'))
  expect(repairFacts).toContain('"repairKind":"diagnostic"')
  expect(repairFacts).not.toContain('"authorRevision"')
  expect(await readFile(join(f.projectRoot, entryPath), 'utf8')).toBe('say:原稿;')
  expect(f.git('rev-parse', 'HEAD')).toBe(baselineCommit)
  const execution = await f.app.ports.executions.readExecution(request)
  const candidate = await f.app.ports.artifacts.readCandidate(
    execution!,
    execution!.candidateSnapshotId!
  )
  expect(candidate.preview.validationReport.issues).toEqual([])
  const statements = candidate.artifact.statements
  expect(statements.map((statement) => statement.command)).toEqual(
    expect.arrayContaining(['changeBg', 'say', 'end'])
  )
  expect(statements.map((statement) => statement.content).join('\n')).toContain('station.svg')
  expect(statements.map((statement) => statement.content).join('\n')).not.toContain('missing.svg')
})

it('重启后审阅边界仍可读，丢弃只清本候选且不提交正式作品', async () => {
  const f = await generationFixture()
  const baselineCommit = f.git('rev-parse', 'HEAD')
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const waiting = await f.app.status.getSceneGenerationStatus(request)
  expect(waiting.state).toBe('waiting')
  const candidateSnapshotId = waiting.candidateSnapshotId!
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
    reply: { kind: 'discard' as const }
  }
  await restarted.generation.replySceneGenerationInteraction(reply)
  expect((await restarted.ports.executions.readExecution(request))?.pendingReply?.replyId).toBe(
    'reply-1'
  )
  await f.run()
  const finished = await restarted.status.getSceneGenerationStatus(request)
  expect(finished.state).toBe('cancelled')
  expect(finished.candidateSnapshotId).toBe(candidateSnapshotId)
  expect(await readFile(join(f.projectRoot, entryPath), 'utf8')).toBe('say:原稿;')
  expect(f.git('rev-parse', 'HEAD')).toBe(baselineCommit)
  await restarted.generation.replySceneGenerationInteraction(reply)
})

it('活跃期限到期中止挂起的模型请求并结束为失败，不冒充用户取消', async () => {
  const f = await generationFixture({
    pauseUntilAbort: true,
    execution: { activeLimitMs: 1200 }
  })
  await f.app.generation.generateScene({
    ...request,
    reviewCandidate: true
  })
  await expect(f.run()).rejects.toThrow(/活跃执行时间已用尽/)
  const status = await f.app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('failed')
  expect(status.canResume).toBe(false)
  const execution = (await f.app.ports.executions.readExecution(request))!
  expect(execution.failure?.message ?? '').toContain('活跃执行时间已用尽')
  expect(execution.cancellationRequested).not.toBe(true)
})

it('接受待审阅候选只在提交网关写入正式作品，重复接受不重复提交', async () => {
  const f = await generationFixture()
  const baselineCommit = f.git('rev-parse', 'HEAD')
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const waiting = await f.app.status.getSceneGenerationStatus(request)
  expect(waiting.state).toBe('waiting')
  const reply = {
    projectId: waiting.projectId,
    sceneId: waiting.sceneId,
    operationId: waiting.operationId,
    threadId: waiting.threadId,
    branchId: waiting.branchId,
    interactionId: waiting.interaction!.interactionId,
    checkpointId: waiting.interaction!.checkpointId,
    candidateSnapshotId: waiting.interaction!.candidateSnapshotId,
    replyId: 'reply-accept',
    reply: { kind: 'accept' as const }
  }
  await f.app.generation.replySceneGenerationInteraction(reply)
  // 回复已持久接受，但正式作品在提交网关执行前保持不变。
  expect(await readFile(join(f.projectRoot, entryPath), 'utf8')).toBe('say:原稿;')
  expect(f.git('rev-parse', 'HEAD')).toBe(baselineCommit)
  await f.run()
  const finished = await f.app.status.getSceneGenerationStatus(request)
  expect(finished.state).toBe('succeeded')
  expect(finished.result?.commitId).toBeTruthy()
  expect(finished.result?.preview.validationReport.issues).toEqual([])
  expect(await readFile(join(f.projectRoot, entryPath), 'utf8')).toBe(validScript)
  expect(f.git('rev-parse', 'HEAD')).toBe(finished.result?.commitId)
  const count = f.bodies.length
  await f.app.generation.replySceneGenerationInteraction(reply)
  expect(f.bodies).toHaveLength(count)
  expect((await f.app.status.getSceneGenerationStatus(request)).state).toBe('succeeded')
  expect(f.git('rev-parse', 'HEAD')).toBe(finished.result?.commitId)
})

it('作者对选中修订提出修改后生成新候选，旧修订与正式作品不变', async () => {
  const f = await generationFixture({
    scriptForWrite: (writes) =>
      writes === 1 ? validScript : 'changeBg:station.svg;\n林:明天见。;\nend;'
  })
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const waiting = await f.app.status.getSceneGenerationStatus(request)
  expect(waiting.state).toBe('waiting')
  const firstSnapshotId = waiting.candidateSnapshotId!
  const reply = {
    projectId: waiting.projectId,
    sceneId: waiting.sceneId,
    operationId: waiting.operationId,
    threadId: waiting.threadId,
    branchId: waiting.branchId,
    interactionId: waiting.interaction!.interactionId,
    checkpointId: waiting.interaction!.checkpointId,
    candidateSnapshotId: waiting.interaction!.candidateSnapshotId,
    replyId: 'reply-revise',
    reply: { kind: 'revise' as const, body: '把道别改成明天见' }
  }
  await f.app.generation.replySceneGenerationInteraction(reply)
  await f.run()
  const revised = await f.app.status.getSceneGenerationStatus(request)
  expect(revised.state).toBe('waiting')
  expect(revised.interaction?.kind).toBe('review')
  expect(revised.interaction?.allowedReplies).toEqual(['accept', 'revise', 'discard'])
  expect(revised.interaction?.message).not.toContain('当前构建')
  expect(revised.candidateSnapshotId).not.toBe(firstSnapshotId)
  expect(await readFile(join(f.projectRoot, entryPath), 'utf8')).toBe('say:原稿;')
  const execution = (await f.app.ports.executions.readExecution(request))!
  const current = await f.app.ports.artifacts.readCandidate(execution, revised.candidateSnapshotId!)
  expect(current.artifact.statements.map((item) => item.content).join('\n')).toContain('明天见')
  // 旧修订仍以不可变 Git 修订保存，内容保持修改前版本。
  const revisionGitDir = join(
    f.root,
    'state/ai/projects',
    request.projectId,
    'threads',
    waiting.threadId,
    'revisions'
  )
  const originalEntry = execFileSync(
    'git',
    ['--git-dir', revisionGitDir, 'show', `${firstSnapshotId}:${entryPath}`],
    { encoding: 'utf8' }
  )
  expect(originalEntry).toBe(validScript)
  const originalCandidate = execFileSync(
    'git',
    ['--git-dir', revisionGitDir, 'rev-parse', `refs/opengalgame/revisions/${firstSnapshotId}`],
    { encoding: 'utf8' }
  ).trim()
  expect(originalCandidate).toBe(firstSnapshotId)
  expect(f.bodies.some((body) => JSON.stringify(body.messages).includes('把道别改成明天见'))).toBe(
    true
  )
})

it('修正等待只允许提出修改或丢弃，修改后重新进入审阅', async () => {
  const f = await generationFixture({
    scriptForWrite: (writes) =>
      writes <= 2 ? validScript.replace('station.svg', 'missing.svg') : validScript
  })
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const correction = await f.app.status.getSceneGenerationStatus(request)
  expect(correction.state).toBe('waiting')
  expect(correction.interaction?.kind).toBe('correction')
  expect(correction.interaction?.allowedReplies).toEqual(['revise', 'discard'])
  expect(correction.interaction?.allowedReplies).not.toContain('accept')
  const correctionExecution = (await f.app.ports.executions.readExecution(request))!
  expect(correctionExecution.artifactValidation?.issues.length).toBeGreaterThan(0)
  const reply = {
    projectId: correction.projectId,
    sceneId: correction.sceneId,
    operationId: correction.operationId,
    threadId: correction.threadId,
    branchId: correction.branchId,
    interactionId: correction.interaction!.interactionId,
    checkpointId: correction.interaction!.checkpointId,
    candidateSnapshotId: correction.interaction!.candidateSnapshotId,
    replyId: 'reply-correction',
    reply: { kind: 'revise' as const, body: '背景改用本次提供的车站素材' }
  }
  await f.app.generation.replySceneGenerationInteraction(reply)
  await f.run()
  const review = await f.app.status.getSceneGenerationStatus(request)
  expect(review.state).toBe('waiting')
  expect(review.interaction?.kind).toBe('review')
  expect(review.interaction?.allowedReplies).toEqual(['accept', 'revise', 'discard'])
  const reviewedExecution = (await f.app.ports.executions.readExecution(request))!
  expect(reviewedExecution.artifactValidation?.issues).toEqual([])
  expect(await readFile(join(f.projectRoot, entryPath), 'utf8')).toBe('say:原稿;')
})

it('接受前正式场景被改动时保留候选与用户内容，不覆盖', async () => {
  const f = await generationFixture()
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const waiting = await f.app.status.getSceneGenerationStatus(request)
  expect(waiting.state).toBe('waiting')
  const reply = {
    projectId: waiting.projectId,
    sceneId: waiting.sceneId,
    operationId: waiting.operationId,
    threadId: waiting.threadId,
    branchId: waiting.branchId,
    interactionId: waiting.interaction!.interactionId,
    checkpointId: waiting.interaction!.checkpointId,
    candidateSnapshotId: waiting.interaction!.candidateSnapshotId,
    replyId: 'reply-accept-conflict',
    reply: { kind: 'accept' as const }
  }
  await f.app.generation.replySceneGenerationInteraction(reply)
  await writeFile(join(f.projectRoot, entryPath), 'say:用户后来修改;')
  await expect(f.run()).rejects.toThrow()
  const status = await f.app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('interrupted')
  const execution = (await f.app.ports.executions.readExecution(request))!
  expect(execution.interruptReason).toBe('candidateConflict')
  expect(execution.candidateSnapshotId).toBe(waiting.candidateSnapshotId)
  expect(execution.pendingReply).toBeUndefined()
  expect(execution.interaction).toBeUndefined()
  expect(execution.artifactValidation?.issues).toEqual([])
  expect(await readFile(join(f.projectRoot, entryPath), 'utf8')).toBe('say:用户后来修改;')
  // 冲突后可只读重新核对候选，再结束本次；正式内容保持作者修改。
  const opened: string[] = []
  const preview = new OpenSceneGenerationCandidatePreviewUseCase(
    {
      deps: {
        history: { listHistory: async () => ({ branches: [], checkpoints: [] }) }
      },
      coordinator: { requireExecution: async () => execution }
    } as never,
    {
      preview: {
        openPublishedCandidatePreview: async (previewRequest: { candidateSnapshotId: string }) => {
          opened.push(previewRequest.candidateSnapshotId)
          return {
            preview: {
              previewSessionId: 'conflict-preview',
              candidateSnapshotId: previewRequest.candidateSnapshotId,
              url: '',
              expiresAt: ''
            },
            stage: Promise.resolve()
          }
        }
      }
    } as never
  )
  await preview.openSceneGenerationCandidatePreview({
    projectId: waiting.projectId,
    sceneId: waiting.sceneId,
    operationId: waiting.operationId,
    threadId: waiting.threadId,
    branchId: waiting.branchId,
    checkpointId: waiting.interaction!.checkpointId,
    candidateSnapshotId: waiting.candidateSnapshotId!
  })
  expect(opened).toEqual([waiting.candidateSnapshotId])
  const cancelled = await f.app.generation.cancelSceneGeneration(request)
  expect(cancelled.state).toBe('cancelled')
  expect(await readFile(join(f.projectRoot, entryPath), 'utf8')).toBe('say:用户后来修改;')
})

it('阶段二只含丢弃的等待记录迁移后恢复接受动作并提交', async () => {
  const f = await generationFixture()
  const baselineCommit = f.git('rev-parse', 'HEAD')
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const waiting = await f.app.status.getSceneGenerationStatus(request)
  expect(waiting.state).toBe('waiting')
  const recordPath = join(
    f.root,
    'state/scene-generation/projects',
    request.projectId,
    'executions.json'
  )
  const document = JSON.parse(await readFile(recordPath, 'utf8')) as {
    executions: Array<Record<string, unknown> & { operationId: string }>
  }
  const index = document.executions.findIndex((item) => item.operationId === waiting.operationId)
  expect(index).toBeGreaterThanOrEqual(0)
  document.executions[index] = {
    ...document.executions[index],
    interaction: {
      ...(document.executions[index].interaction as Record<string, unknown>),
      allowedReplies: ['discard'],
      message:
        '请审阅当前候选（1 条语句，0 个校验问题）。' +
        '当前构建支持预览与丢弃；接受与修订将在后续阶段启用。'
    }
  }
  delete document.executions[index].publishedCandidates
  await writeFile(recordPath, `${JSON.stringify(document, null, 2)}\n`)
  const restarted = await createSceneGeneration(f.config)
  const restored = await restarted.status.getSceneGenerationStatus(request)
  expect(restored.interaction).toMatchObject({
    kind: 'review',
    allowedReplies: ['accept', 'revise', 'discard']
  })
  expect(restored.interaction?.message).not.toContain('当前构建')
  const upgradedExecution = (await restarted.ports.executions.readExecution(request))!
  expect(upgradedExecution.publishedCandidates?.map((item) => item.candidateSnapshotId)).toEqual([
    waiting.candidateSnapshotId
  ])
  const persisted = JSON.parse(await readFile(recordPath, 'utf8')) as {
    executions: Array<{ interaction?: { allowedReplies: string[] } }>
  }
  expect(persisted.executions[index].interaction?.allowedReplies).toEqual([
    'accept',
    'revise',
    'discard'
  ])
  const reply = {
    projectId: restored.projectId,
    sceneId: restored.sceneId,
    operationId: restored.operationId,
    threadId: restored.threadId,
    branchId: restored.branchId,
    interactionId: restored.interaction!.interactionId,
    checkpointId: restored.interaction!.checkpointId,
    candidateSnapshotId: restored.interaction!.candidateSnapshotId,
    replyId: 'reply-upgraded',
    reply: { kind: 'accept' as const }
  }
  await restarted.generation.replySceneGenerationInteraction(reply)
  await f.run()
  const finished = await restarted.status.getSceneGenerationStatus(request)
  expect(finished.state).toBe('succeeded')
  expect(await readFile(join(f.projectRoot, entryPath), 'utf8')).toBe(validScript)
  expect(f.git('rev-parse', 'HEAD')).toBe(finished.result?.commitId)
  expect(f.git('rev-parse', 'HEAD')).not.toBe(baselineCommit)
})

it('回复已持久但任务未执行时，重启可安全重放接受且不重复提交', async () => {
  const f = await generationFixture()
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const waiting = await f.app.status.getSceneGenerationStatus(request)
  expect(waiting.state).toBe('waiting')
  const bodies = f.bodies.length
  const reply = {
    projectId: waiting.projectId,
    sceneId: waiting.sceneId,
    operationId: waiting.operationId,
    threadId: waiting.threadId,
    branchId: waiting.branchId,
    interactionId: waiting.interaction!.interactionId,
    checkpointId: waiting.interaction!.checkpointId,
    candidateSnapshotId: waiting.interaction!.candidateSnapshotId,
    replyId: 'reply-restart-accept',
    reply: { kind: 'accept' as const }
  }
  await f.app.generation.replySceneGenerationInteraction(reply)
  expect(f.jobs).toHaveLength(1)
  // 模拟回复已落盘但进程在后台任务执行前丢失原任务。
  f.jobs.splice(0)
  const restarted = await createSceneGeneration(f.config)
  const resumed = await restarted.generation.resumeSceneGeneration(request)
  expect(resumed.state).toBe('pending')
  expect(f.jobs).toHaveLength(1)
  await f.run()
  const finished = await restarted.status.getSceneGenerationStatus(request)
  expect(finished.state).toBe('succeeded')
  expect(f.bodies).toHaveLength(bodies)
  expect(await readFile(join(f.projectRoot, entryPath), 'utf8')).toBe(validScript)
  expect(f.git('rev-parse', 'HEAD')).toBe(finished.result?.commitId)
})

it('回复已持久但任务未执行时，重启可安全重放提出修改', async () => {
  const f = await generationFixture({
    scriptForWrite: (writes) =>
      writes === 1 ? validScript : 'changeBg:station.svg;\n林:重启后仍按修改意见。;\nend;'
  })
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const waiting = await f.app.status.getSceneGenerationStatus(request)
  expect(waiting.state).toBe('waiting')
  const reply = {
    projectId: waiting.projectId,
    sceneId: waiting.sceneId,
    operationId: waiting.operationId,
    threadId: waiting.threadId,
    branchId: waiting.branchId,
    interactionId: waiting.interaction!.interactionId,
    checkpointId: waiting.interaction!.checkpointId,
    candidateSnapshotId: waiting.interaction!.candidateSnapshotId,
    replyId: 'reply-restart-revise',
    reply: { kind: 'revise' as const, body: '把结尾改成重启后的版本' }
  }
  await f.app.generation.replySceneGenerationInteraction(reply)
  expect(f.jobs).toHaveLength(1)
  f.jobs.splice(0)
  const bodyCount = f.bodies.length
  const restarted = await createSceneGeneration(f.config)
  const resumed = await restarted.generation.resumeSceneGeneration(request)
  expect(resumed.state).toBe('pending')
  await f.run()
  const revised = await restarted.status.getSceneGenerationStatus(request)
  expect(revised.state).toBe('waiting')
  expect(revised.interaction?.kind).toBe('review')
  expect(revised.candidateSnapshotId).not.toBe(waiting.candidateSnapshotId)
  expect(f.bodies.length).toBeGreaterThan(bodyCount)
  expect(await readFile(join(f.projectRoot, entryPath), 'utf8')).toBe('say:原稿;')
  expect(
    f.bodies.some((body) => JSON.stringify(body.messages).includes('把结尾改成重启后的版本'))
  ).toBe(true)
})

it('修改后旧修订按原检查点只读预览，未登记修订仍拒绝', async () => {
  const f = await generationFixture({
    scriptForWrite: (writes) =>
      writes === 1 ? validScript : 'changeBg:station.svg;\n林:只改结尾。;\nend;'
  })
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const first = await f.app.status.getSceneGenerationStatus(request)
  expect(first.state).toBe('waiting')
  const reply = {
    projectId: first.projectId,
    sceneId: first.sceneId,
    operationId: first.operationId,
    threadId: first.threadId,
    branchId: first.branchId,
    interactionId: first.interaction!.interactionId,
    checkpointId: first.interaction!.checkpointId,
    candidateSnapshotId: first.interaction!.candidateSnapshotId,
    replyId: 'reply-old-preview',
    reply: { kind: 'revise' as const, body: '只改结尾' }
  }
  await f.app.generation.replySceneGenerationInteraction(reply)
  await f.run()
  const revised = await f.app.status.getSceneGenerationStatus(request)
  expect(revised.state).toBe('waiting')
  expect(revised.candidateSnapshotId).not.toBe(first.candidateSnapshotId)
  const execution = (await f.app.ports.executions.readExecution(request))!
  expect(execution.publishedCandidates?.map((item) => item.candidateSnapshotId)).toEqual([
    first.candidateSnapshotId,
    revised.candidateSnapshotId
  ])
  const opened: string[] = []
  const preview = new OpenSceneGenerationCandidatePreviewUseCase(
    {
      deps: {
        history: { listHistory: async () => ({ branches: [], checkpoints: [] }) }
      },
      coordinator: { requireExecution: async () => execution }
    } as never,
    {
      preview: {
        openPublishedCandidatePreview: async (previewRequest: { candidateSnapshotId: string }) => {
          opened.push(previewRequest.candidateSnapshotId)
          return {
            preview: {
              previewSessionId: 'old-revision-preview',
              candidateSnapshotId: previewRequest.candidateSnapshotId,
              url: '',
              expiresAt: ''
            },
            stage: Promise.resolve()
          }
        }
      }
    } as never
  )
  const scope = {
    projectId: first.projectId,
    sceneId: first.sceneId,
    operationId: first.operationId,
    threadId: first.threadId,
    branchId: first.branchId
  }
  await preview.openSceneGenerationCandidatePreview({
    ...scope,
    checkpointId: first.interaction!.checkpointId,
    candidateSnapshotId: first.candidateSnapshotId!
  })
  expect(opened).toEqual([first.candidateSnapshotId])
  const revisionGitDir = join(
    f.root,
    'state/ai/projects',
    request.projectId,
    'threads',
    first.threadId,
    'revisions'
  )
  const oldEntry = execFileSync(
    'git',
    ['--git-dir', revisionGitDir, 'show', `${first.candidateSnapshotId}:${entryPath}`],
    { encoding: 'utf8' }
  )
  expect(oldEntry).toBe(validScript)
  await expect(
    preview.openSceneGenerationCandidatePreview({
      ...scope,
      checkpointId: 'pi-review-not-recorded',
      candidateSnapshotId: 'c'.repeat(40)
    })
  ).rejects.toThrow('候选修订未发布')
})

it('提交已完成但执行记录未落成功时，重启按提交回执收尾且不重复提交', async () => {
  const f = await generationFixture()
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const waiting = await f.app.status.getSceneGenerationStatus(request)
  expect(waiting.state).toBe('waiting')
  const reply = {
    projectId: waiting.projectId,
    sceneId: waiting.sceneId,
    operationId: waiting.operationId,
    threadId: waiting.threadId,
    branchId: waiting.branchId,
    interactionId: waiting.interaction!.interactionId,
    checkpointId: waiting.interaction!.checkpointId,
    candidateSnapshotId: waiting.interaction!.candidateSnapshotId,
    replyId: 'reply-commit-receipt',
    reply: { kind: 'accept' as const }
  }
  await f.app.generation.replySceneGenerationInteraction(reply)
  await f.run()
  const finished = await f.app.status.getSceneGenerationStatus(request)
  expect(finished.state).toBe('succeeded')
  const execution = (await f.app.ports.executions.readExecution(request))!
  const accepted = execution.replies.at(-1)
  expect(accepted?.replyId).toBe(reply.replyId)
  const commitId = finished.result?.commitId
  const head = f.git('rev-parse', 'HEAD')
  const commitCount = f.git('rev-list', '--count', 'HEAD')
  const bodies = f.bodies.length
  // 模拟提交已完成、成功记录尚未写回的进程丢失。
  await f.app.ports.executions.writeExecution({
    ...execution,
    state: 'pending',
    pendingReply: accepted,
    result: undefined
  })
  const restarted = await createSceneGeneration(f.config)
  const resumed = await restarted.generation.resumeSceneGeneration(request)
  expect(resumed.state).toBe('succeeded')
  expect(f.jobs).toHaveLength(0)
  expect(f.bodies).toHaveLength(bodies)
  expect(f.git('rev-parse', 'HEAD')).toBe(head)
  expect(f.git('rev-list', '--count', 'HEAD')).toBe(commitCount)
  expect((await restarted.status.getSceneGenerationStatus(request)).result?.commitId).toBe(commitId)
})

it('人工编辑后从实际新修订重新校验并提交到正式作品', async () => {
  const f = await generationFixture()
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const waiting = await f.app.status.getSceneGenerationStatus(request)
  expect(waiting.state).toBe('waiting')
  const editedText = 'changeBg:station.svg;\n林:人工修改后的台词。;\nend;'
  await f.app.candidateEdit.editSceneGenerationCandidate({
    ...request,
    candidateSnapshotId: waiting.candidateSnapshotId!,
    files: [{ relativePath: entryPath, content: editedText }]
  })
  const edited = await f.app.status.getSceneGenerationStatus(request)
  expect(edited.state).toBe('interrupted')
  expect(edited.candidateSnapshotId).not.toBe(waiting.candidateSnapshotId)
  const editedExecution = (await f.app.ports.executions.readExecution(request))!
  expect(editedExecution.artifactValidation).toBeUndefined()
  expect(editedExecution.checkpointId).toBeUndefined()
  await f.app.generation.resumeSceneGeneration(request)
  await f.run()
  const review = await f.app.status.getSceneGenerationStatus(request)
  expect(review.state).toBe('waiting')
  expect(review.interaction?.kind).toBe('review')
  expect(review.interaction?.allowedReplies).toEqual(['accept', 'revise', 'discard'])
  expect(review.candidateSnapshotId).toBe(edited.candidateSnapshotId)
  const reviewedExecution = (await f.app.ports.executions.readExecution(request))!
  expect(reviewedExecution.artifactValidation?.issues).toEqual([])
  expect(await readFile(join(f.projectRoot, entryPath), 'utf8')).toBe('say:原稿;')
  const reply = {
    projectId: review.projectId,
    sceneId: review.sceneId,
    operationId: review.operationId,
    threadId: review.threadId,
    branchId: review.branchId,
    interactionId: review.interaction!.interactionId,
    checkpointId: review.interaction!.checkpointId,
    candidateSnapshotId: review.interaction!.candidateSnapshotId,
    replyId: 'reply-edited-accept',
    reply: { kind: 'accept' as const }
  }
  await f.app.generation.replySceneGenerationInteraction(reply)
  await f.run()
  const finished = await f.app.status.getSceneGenerationStatus(request)
  expect(finished.state).toBe('succeeded')
  expect(await readFile(join(f.projectRoot, entryPath), 'utf8')).toBe(editedText)
  expect(f.git('rev-parse', 'HEAD')).toBe(finished.result?.commitId)
})

it('修改写入已完成但审阅记录未写回时，重启复用修订且不重跑模型', async () => {
  const f = await generationFixture({
    scriptForWrite: (writes) =>
      writes === 1 ? validScript : 'changeBg:station.svg;\n林:写入已完成。;\nend;'
  })
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const first = await f.app.status.getSceneGenerationStatus(request)
  const reply = {
    projectId: first.projectId,
    sceneId: first.sceneId,
    operationId: first.operationId,
    threadId: first.threadId,
    branchId: first.branchId,
    interactionId: first.interaction!.interactionId,
    checkpointId: first.interaction!.checkpointId,
    candidateSnapshotId: first.interaction!.candidateSnapshotId,
    replyId: 'reply-effect-replay',
    reply: { kind: 'revise' as const, body: '把结尾改成完成态' }
  }
  await f.app.generation.replySceneGenerationInteraction(reply)
  await f.run()
  const completed = await f.app.status.getSceneGenerationStatus(request)
  expect(completed.state).toBe('waiting')
  expect(completed.candidateSnapshotId).not.toBe(first.candidateSnapshotId)
  const execution = (await f.app.ports.executions.readExecution(request))!
  const accepted = execution.replies.find((item) => item.replyId === reply.replyId)
  expect(accepted).toBeDefined()
  const bodies = f.bodies.length
  // 模拟写入与不可变修订已完成，但等待审阅记录尚未写回的进程丢失。
  await f.app.ports.executions.writeExecution({
    ...execution,
    state: 'pending',
    pendingReply: accepted,
    interaction: undefined
  })
  const restarted = await createSceneGeneration(f.config)
  await restarted.generation.resumeSceneGeneration(request)
  await f.run()
  const replayed = await restarted.status.getSceneGenerationStatus(request)
  expect(replayed.state).toBe('waiting')
  expect(replayed.candidateSnapshotId).toBe(completed.candidateSnapshotId)
  expect(replayed.interaction?.kind).toBe('review')
  expect(f.bodies).toHaveLength(bodies)
  expect(await readFile(join(f.projectRoot, entryPath), 'utf8')).toBe('say:原稿;')
})

it('整组回答写入后审阅记录未写回时，跨重启复用完成记录且两次结算都不重写或调用模型', async () => {
  const f = await clarificationAnswerFixture(clarificationQuestions)
  const baselineCommit = f.git('rev-parse', 'HEAD')
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const asking = await f.app.status.getSceneGenerationStatus(request)
  expect(asking.state).toBe('waiting')
  expect(asking.interaction?.kind).toBe('decision')
  const stored = (await f.app.ports.executions.readExecution(request))!
  const answerReply = {
    projectId: stored.projectId,
    sceneId: stored.sceneId,
    operationId: stored.operationId,
    threadId: stored.threadId,
    branchId: stored.branchId,
    interactionId: stored.interaction!.interactionId,
    checkpointId: stored.interaction!.checkpointId,
    candidateSnapshotId: stored.interaction!.candidateSnapshotId,
    replyId: 'reply-answers-crash',
    reply: {
      kind: 'answers' as const,
      answers: stored.interaction!.questions!.map((question, index) => ({
        questionId: question.questionId,
        optionId: question.options[index % question.options.length].id
      }))
    }
  }
  await f.app.generation.replySceneGenerationInteraction(answerReply)
  await f.run()
  const completed = await f.app.status.getSceneGenerationStatus(request)
  expect(completed.state).toBe('waiting')
  expect(completed.interaction?.kind).toBe('review')
  const candidateSnapshotId = completed.candidateSnapshotId!
  const execution = (await f.app.ports.executions.readExecution(request))!
  const accepted = execution.replies.find((item) => item.replyId === answerReply.replyId)
  expect(accepted).toBeDefined()
  const stateRoot = join(f.config.userStateRoot, 'ai')
  const effects = await readDurableEffects(stateRoot, execution)
  expect(effects).toHaveLength(1)
  expect(effects[0]).toMatchObject({
    status: 'completed',
    candidateRevision: candidateSnapshotId
  })
  const bodies = f.bodies.length
  // 模拟写入与不可变修订已完成，但等待审阅记录尚未写回的进程丢失：
  // 保留整组回答的 pendingReply 和旧题组检查点，候选快照已由写后记录绑定。
  const crashRecord = {
    ...execution,
    state: 'pending' as const,
    step: undefined,
    interaction: undefined,
    pendingReply: accepted,
    checkpointId: stored.checkpointId,
    artifactValidation: undefined,
    publishedCandidates: undefined,
    live: undefined
  }
  await f.app.ports.executions.writeExecution(crashRecord)
  const restarted = await createSceneGeneration(f.config)
  await restarted.generation.resumeSceneGeneration(request)
  await f.run()
  const replayed = await restarted.status.getSceneGenerationStatus(request)
  expect(replayed.state).toBe('waiting')
  expect(replayed.interaction?.kind).toBe('review')
  expect(replayed.candidateSnapshotId).toBe(candidateSnapshotId)
  expect(f.bodies).toHaveLength(bodies)
  expect(f.git('rev-parse', 'HEAD')).toBe(baselineCommit)
  expect(await readFile(join(f.projectRoot, entryPath), 'utf8')).toBe('say:原稿;')
  const replayedExecution = (await restarted.ports.executions.readExecution(request))!
  expect(await readDurableEffects(stateRoot, replayedExecution)).toHaveLength(1)

  // 再模拟一次“恢复结果尚未落回等待记录”的丢失；同一完成记录只能被读取和复用。
  await f.app.ports.executions.writeExecution(crashRecord)
  const restartedAgain = await createSceneGeneration(f.config)
  await restartedAgain.generation.resumeSceneGeneration(request)
  await f.run()
  const replayedAgain = await restartedAgain.status.getSceneGenerationStatus(request)
  expect(replayedAgain.state).toBe('waiting')
  expect(replayedAgain.candidateSnapshotId).toBe(candidateSnapshotId)
  expect(f.bodies).toHaveLength(bodies)
  expect(f.git('rev-parse', 'HEAD')).toBe(baselineCommit)
  expect(await readDurableEffects(stateRoot, replayedExecution)).toHaveLength(1)
})

it('整组回答写入回执不明时跨重启保留待核对状态，不调用模型、不清理也不覆盖候选', async () => {
  const f = await clarificationAnswerFixture(clarificationQuestions)
  const baselineCommit = f.git('rev-parse', 'HEAD')
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const stored = (await f.app.ports.executions.readExecution(request))!
  const answerReply = {
    projectId: stored.projectId,
    sceneId: stored.sceneId,
    operationId: stored.operationId,
    threadId: stored.threadId,
    branchId: stored.branchId,
    interactionId: stored.interaction!.interactionId,
    checkpointId: stored.interaction!.checkpointId,
    candidateSnapshotId: stored.interaction!.candidateSnapshotId,
    replyId: 'reply-answers-unknown',
    reply: {
      kind: 'answers' as const,
      answers: stored.interaction!.questions!.map((question, index) => ({
        questionId: question.questionId,
        optionId: question.options[index % question.options.length].id
      }))
    }
  }
  await f.app.generation.replySceneGenerationInteraction(answerReply)
  await f.run()
  const execution = (await f.app.ports.executions.readExecution(request))!
  const accepted = execution.replies.find((item) => item.replyId === answerReply.replyId)
  expect(accepted).toBeDefined()
  const stateRoot = join(f.config.userStateRoot, 'ai')
  const effects = await readDurableEffects(stateRoot, execution)
  expect(effects).toHaveLength(1)
  const completedCandidate = execution.candidateSnapshotId!
  // 模拟写入意图已落盘、但完成记录和候选绑定都未写回，且输入摘要无法核对：
  // 工作区修订存在但归属不可证明，恢复门必须保留现场而不是重建工作区。
  await writeDurableEffect(stateRoot, execution, {
    ...effects[0],
    status: 'started',
    inputDigest: 'f'.repeat(64),
    candidateRevision: undefined,
    resultDigest: undefined
  })
  const bodies = f.bodies.length
  await f.app.ports.executions.writeExecution({
    ...execution,
    state: 'pending',
    candidateSnapshotId: undefined,
    checkpointId: stored.checkpointId,
    interaction: undefined,
    pendingReply: accepted,
    artifactValidation: undefined,
    publishedCandidates: undefined,
    live: undefined
  })
  const restarted = await createSceneGeneration(f.config)
  await restarted.generation.resumeSceneGeneration(request)
  await f.run()
  // 回执不明不是终结失败：持久状态和对外投影都保持待核对。
  const pending = await restarted.status.getSceneGenerationStatus(request)
  expect(pending.state).toBe('interrupted')
  expect(pending.failure).toMatchObject({ unverified: true })
  expect(pending.failure?.message).toContain('待核对')
  expect(f.bodies).toHaveLength(bodies)
  expect(f.git('rev-parse', 'HEAD')).toBe(baselineCommit)
  expect(await readFile(join(f.projectRoot, entryPath), 'utf8')).toBe('say:原稿;')
  const after = (await restarted.ports.executions.readExecution(request))!
  expect(after.interruptReason).toBe('writeUnknown')
  expect(after.pendingReply?.replyId).toBe(answerReply.replyId)
  expect(after.replies.map((item) => item.replyId)).toContain(answerReply.replyId)
  // 保留的只是本操作工作区引用的只读事实，没有被当成本次写入的通过结论。
  expect(after.candidateSnapshotId).toBe(completedCandidate)
  expect(after.interaction).toBeUndefined()
  expect(after.requiresCleanup).not.toBe(true)
  const afterEffects = await readDurableEffects(stateRoot, after)
  expect(afterEffects).toHaveLength(1)
  expect(afterEffects[0].status).toBe('started')

  // 跨重开仍可见待核对；恢复被拒绝，且不调用模型、不改写副作用账本。
  const reopened = await createSceneGeneration(f.config)
  const reopenedStatus = await reopened.status.getSceneGenerationStatus(request)
  expect(reopenedStatus.state).toBe('interrupted')
  expect(reopenedStatus.failure).toMatchObject({ unverified: true })
  expect(reopenedStatus.failure?.message).toContain('待核对')
  const persisted = (await reopened.ports.executions.readExecution(request))!
  expect(persisted.interruptReason).toBe('writeUnknown')
  expect(persisted.pendingReply?.replyId).toBe(answerReply.replyId)
  expect(persisted.replies.map((item) => item.replyId)).toContain(answerReply.replyId)
  await expect(reopened.generation.resumeSceneGeneration(request)).rejects.toMatchObject({
    code: 4103
  })
  expect(f.bodies).toHaveLength(bodies)
  expect(f.git('rev-parse', 'HEAD')).toBe(baselineCommit)
  expect(await readFile(join(f.projectRoot, entryPath), 'utf8')).toBe('say:原稿;')
  const still = await readDurableEffects(stateRoot, persisted)
  expect(still).toHaveLength(1)
  expect(still[0].status).toBe('started')
})
