import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type {
  PiAgentExecutor,
  PiAgentRunRequest,
  PiAgentRunResult
} from '@infrastructure/ai/pi/PiAgentExecutor'
import type { FilePromptLoader } from '@infrastructure/ai/prompts/FilePromptLoader'
import type { FileSkillLoader } from '@infrastructure/ai/skills/FileSkillLoader'
import type { SceneArtifactGateway } from '@application/scene-generation/ports/SceneArtifactGateway'
import type { SceneGenerationDomainService } from '@domain/scene-generation/services/SceneGenerationDomainService'
import type {
  SceneGenerationCandidate,
  SceneGenerationExecution,
  SceneGenerationRuntime,
  SceneGenerationWorkflowProgress
} from '@application/scene-generation/models/SceneGenerationExecution'
import type {
  SceneValidationIssueCode,
  SceneValidationReport
} from '@domain/scene-generation/models/SceneValidationReport'
import { PiSceneGenerationWorkflow } from '@infrastructure/scene-generation/pi/PiSceneGenerationWorkflow'
import { candidateInputDigest } from '@infrastructure/scene-generation/workflow/graph/candidateRevision'
import {
  readPauseBoundary,
  writePauseBoundary,
  type PiPauseBoundary
} from '@infrastructure/scene-generation/pi/PiPauseBoundary'
import { FileSceneGenerationExecutionRepositoryImpl } from '@infrastructure/scene-generation/execution/FileSceneGenerationExecutionRepositoryImpl'
import { WebGalSceneGenerationHistoryReaderImpl } from '@infrastructure/scene-generation/history/WebGalSceneGenerationHistoryReaderImpl'
import { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import { ReadOnlyGenerationCheckpointStore } from '@infrastructure/workflow/checkpoints/ReadOnlyCheckpointStore'
import {
  readDurableEffects,
  writeDurableEffect
} from '@infrastructure/workflow/execution/durableEffect'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const entryPath = 'game/scene/start.txt'
const correctableScript = 'changeBg:missing.svg;\nsay:台词 -clear;\nend;'
const validScript = 'changeBg:station.svg;\nsay:修好的台词 -clear;\nend;'

interface Harness {
  readonly root: string
  readonly workspaceRoot: string
  readonly entry: string
  readonly stateRoot: string
  readonly executions: FileSceneGenerationExecutionRepositoryImpl
  readonly history: WebGalSceneGenerationHistoryReaderImpl
  readonly revisions: Map<string, SceneGenerationCandidate>
  readonly execution: SceneGenerationExecution
  readonly artifacts: Pick<SceneArtifactGateway, 'readCandidate' | 'saveCandidateRevision'>
  newWorkflow(
    agent: PiAgentExecutor,
    domain?: SceneGenerationDomainService
  ): PiSceneGenerationWorkflow
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'pi-pause-resume-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  const entry = join(workspaceRoot, entryPath)
  await mkdir(join(workspaceRoot, 'game/scene'), { recursive: true })
  await writeFile(entry, 'say:种子 -clear;')
  const userRoot = join(root, 'state')
  const stateRoot = join(userRoot, 'ai')
  const executions = new FileSceneGenerationExecutionRepositoryImpl(userRoot)
  const files = new AiProjectFileSystemImpl(userRoot)
  const history = new WebGalSceneGenerationHistoryReaderImpl(
    stateRoot,
    new ReadOnlyGenerationCheckpointStore(stateRoot),
    files,
    executions
  )
  const revisions = new Map<string, SceneGenerationCandidate>()
  const artifacts: Pick<SceneArtifactGateway, 'readCandidate' | 'saveCandidateRevision'> = {
    async saveCandidateRevision() {
      const content = await readFile(entry, 'utf8')
      const revision = createHash('sha256').update(content).digest('hex')
      revisions.set(revision, candidateOf(revision, content))
      return { candidateSnapshotId: revision }
    },
    async readCandidate(_execution, candidateSnapshotId) {
      const cached = revisions.get(candidateSnapshotId)
      if (cached) return cached
      const content = await readFile(entry, 'utf8')
      if (createHash('sha256').update(content).digest('hex') !== candidateSnapshotId)
        throw new Error('候选修订不存在')
      return candidateOf(candidateSnapshotId, content)
    }
  }
  const execution = executionOf(workspaceRoot)
  await executions.createExecution(execution)
  return {
    root,
    workspaceRoot,
    entry,
    stateRoot,
    executions,
    history,
    revisions,
    execution,
    artifacts,
    newWorkflow(agent, domain = domainOf()) {
      return new PiSceneGenerationWorkflow({
        artifacts,
        versions: {
          async inspectBaseline() {
            return { baselineState: 'unchanged' as const, lockState: 'unlocked' as const }
          }
        },
        domain,
        prompts: {
          async load() {
            return { reference: { agentId: 'webgal-scene' }, body: 'SYS', digest: 'prompt' }
          }
        } as unknown as FilePromptLoader,
        skills: {
          async load() {
            return { id: 'webgal-scene', files: [], digest: 'skill' }
          }
        } as unknown as FileSkillLoader,
        stateRoot,
        createAgent: async () => agent,
        nextId: () => 'next-id',
        now: () => 1
      })
    }
  }
}

/** 第一轮写出可修正候选后请求暂停；暂停在下一轮模型调用前生效。 */
async function pausedHarness(): Promise<{
  readonly h: Harness
  readonly paused: SceneGenerationExecution
  readonly boundary: PiPauseBoundary
  readonly firstTools: readonly AgentTool[]
}> {
  const h = await harness()
  const workflowRef: { current?: PiSceneGenerationWorkflow } = {}
  let firstTools: readonly AgentTool[] = []
  let runs = 0
  const agent = {
    async run(request: PiAgentRunRequest): Promise<PiAgentRunResult> {
      runs += 1
      firstTools = request.tools
      const write = request.tools.find((tool) => tool.name === 'writeCandidate')
      if (!write) throw new Error('缺少写工具')
      const revision = /"revision"\s*:\s*"([^"]+)"/.exec(String(request.prompt))?.[1]
      await write.execute(
        'call-write-1',
        { path: entryPath, expectedRevision: revision, content: correctableScript },
        request.signal
      )
      await workflowRef.current!.requestPauseAtSafeCheckpoint(h.execution)
      return succeeded()
    }
  } as unknown as PiAgentExecutor
  const workflow = h.newWorkflow(agent)
  workflowRef.current = workflow
  const outcome = await workflow.executeGeneration(runtimeOf(h.execution))
  expect(runs).toBe(1)
  expect(outcome.state).toBe('interrupted')
  if (outcome.state !== 'interrupted') throw new Error('expected interrupted')
  expect(outcome.interruptReason).toBe('paused')
  expect(outcome.candidateSnapshotId).toBeDefined()
  const paused: SceneGenerationExecution = {
    ...h.execution,
    state: 'interrupted',
    interruptReason: 'paused',
    step: undefined,
    checkpointId: outcome.checkpointId,
    candidateSnapshotId: outcome.candidateSnapshotId,
    budget: outcome.budget,
    pauseRequested: false
  }
  await h.executions.writeExecution(paused)
  const boundary = await readPauseBoundary(h.stateRoot, paused)
  if (!boundary) throw new Error('缺少暂停边界')
  return { h, paused, boundary, firstTools }
}

it('安全暂停持久化边界；重开只读不调模型，显式继续从下一轮只做一次', async () => {
  const { h, paused, boundary } = await pausedHarness()
  expect(boundary.generation).toBe(0)
  expect(boundary.pass).toBe(1)
  expect(boundary.mode).toBe('repair')
  expect(boundary.candidateSnapshotId).toBe(paused.candidateSnapshotId)
  expect(boundary.draftRevision).toBe(createHash('sha256').update(correctableScript).digest('hex'))
  const effects = await readDurableEffects(h.stateRoot, paused)
  expect(effects).toEqual([
    expect.objectContaining({
      stepId: 'generate-0',
      status: 'completed',
      candidateRevision: paused.candidateSnapshotId
    })
  ])

  const checkpoint = await h.history.readCheckpoint({
    projectId: paused.projectId,
    sceneId: paused.sceneId,
    threadId: paused.threadId,
    branchId: paused.branchId,
    checkpointId: paused.checkpointId!
  })
  expect(checkpoint.view.canContinue).toBe(true)
  expect(checkpoint.view.canReply).toBe(false)
  expect(checkpoint.view.summary).toBe('已安全暂停，等待明确继续')

  // 重开：构造新工作流实例并只读取历史，不得创建模型或写候选。
  let prematureRuns = 0
  const reopened = h.newWorkflow({
    async run(): Promise<PiAgentRunResult> {
      prematureRuns += 1
      throw new Error('重开不应自动调用模型')
    }
  } as unknown as PiAgentExecutor)
  expect(prematureRuns).toBe(0)
  expect(reopened.capabilities()).toEqual({
    resume: true,
    pause: true,
    continueInteraction: true,
    fork: true
  })
  const reopenedCheckpoint = await h.history.readCheckpoint({
    projectId: paused.projectId,
    sceneId: paused.sceneId,
    threadId: paused.threadId,
    branchId: paused.branchId,
    checkpointId: paused.checkpointId!
  })
  expect(reopenedCheckpoint.view.canContinue).toBe(true)
  expect(prematureRuns).toBe(0)

  // 显式继续：应用层已把状态改回 running、代次 +1；工作流从边界核对并续做一次。
  let resumeRuns = 0
  const resuming = h.newWorkflow({
    async run(request: PiAgentRunRequest): Promise<PiAgentRunResult> {
      resumeRuns += 1
      const write = request.tools.find((tool) => tool.name === 'writeCandidate')
      if (!write) throw new Error('缺少写工具')
      const revision = /"revision"\s*:\s*"([^"]+)"/.exec(String(request.prompt))?.[1]
      await write.execute(
        'call-write-2',
        { path: entryPath, expectedRevision: revision, content: validScript },
        request.signal
      )
      return succeeded()
    }
  } as unknown as PiAgentExecutor)
  const resumedExecution: SceneGenerationExecution = {
    ...paused,
    state: 'running',
    step: 'preparing',
    attempt: paused.attempt + 1,
    interruptReason: undefined
  }
  const resumed = await resuming.resumeGeneration(runtimeOf(resumedExecution))
  expect(resumeRuns).toBe(1)
  expect(prematureRuns).toBe(0)
  expect(resumed.state).toBe('waiting')
  if (resumed.state !== 'waiting') throw new Error('expected waiting')
  expect(resumed.candidateSnapshotId).toBeDefined()
  expect(resumed.candidateSnapshotId).not.toBe(paused.candidateSnapshotId)
  expect(await readFile(h.entry, 'utf8')).toBe(validScript)
  const resumedEffects = await readDurableEffects(h.stateRoot, paused)
  expect(resumedEffects.map((effect) => [effect.stepId, effect.status])).toEqual([
    ['generate-0', 'completed'],
    ['repair-1', 'completed']
  ])
  // 显式继续到达等待边界后旧暂停边界失效，重复恢复不能重放写入或调用模型。
  expect(await readPauseBoundary(h.stateRoot, paused)).toBeNull()
  const waiting = {
    ...resumedExecution,
    state: 'waiting' as const,
    checkpointId: resumed.checkpointId,
    candidateSnapshotId: resumed.candidateSnapshotId,
    budget: resumed.budget
  }
  await h.executions.writeExecution(waiting)
  const waitingCheckpoint = await h.history.readCheckpoint({
    projectId: waiting.projectId,
    sceneId: waiting.sceneId,
    threadId: waiting.threadId,
    branchId: waiting.branchId,
    checkpointId: waiting.checkpointId!
  })
  expect(waitingCheckpoint.view.canContinue).toBe(false)
  await expect(resuming.resumeGeneration(runtimeOf(waiting))).rejects.toThrow(
    '当前检查点没有可核对的安全暂停边界'
  )
  expect(resumeRuns).toBe(1)
  expect(await readFile(h.entry, 'utf8')).toBe(validScript)
})

it('接受后自动修正到可提交时暂停：保留 reviewAccepted 与 repair-0，重开续做不再调用模型', async () => {
  const h = await harness()
  const revisedScript = 'changeBg:station.svg;\nsay:接受后的修正。 -clear;\nend;'
  let contentJudgment: 'acceptable' | 'correctable' = 'acceptable'
  const domain = {
    evaluateResult(report: SceneValidationReport) {
      return { status: contentJudgment, report }
    }
  } as unknown as SceneGenerationDomainService

  const generating = h.newWorkflow(
    {
      async run(request: PiAgentRunRequest): Promise<PiAgentRunResult> {
        const write = request.tools.find((tool) => tool.name === 'writeCandidate')
        if (!write) throw new Error('缺少写工具')
        const revision = /"revision"\s*:\s*"([^"]+)"/.exec(String(request.prompt))?.[1]
        await write.execute(
          'call-generate',
          { path: entryPath, expectedRevision: revision, content: validScript },
          request.signal
        )
        return succeeded()
      }
    } as unknown as PiAgentExecutor,
    domain
  )
  const waiting = await generating.executeGeneration(runtimeOf(h.execution))
  expect(waiting.state).toBe('waiting')
  if (waiting.state !== 'waiting') throw new Error('expected waiting')
  const acceptedCandidate = waiting.candidateSnapshotId!
  const acceptedExecution: SceneGenerationExecution = {
    ...h.execution,
    state: 'waiting',
    checkpointId: waiting.checkpointId,
    candidateSnapshotId: acceptedCandidate,
    budget: waiting.budget,
    interaction: waiting.interaction
  }
  await h.executions.writeExecution(acceptedExecution)

  const acceptReply = {
    projectId: acceptedExecution.projectId,
    sceneId: acceptedExecution.sceneId,
    operationId: acceptedExecution.operationId,
    threadId: acceptedExecution.threadId,
    branchId: acceptedExecution.branchId,
    interactionId: waiting.interaction.interactionId,
    checkpointId: waiting.checkpointId,
    candidateSnapshotId: acceptedCandidate,
    replyId: 'reply-accept-auto-repair',
    reply: { kind: 'accept' as const }
  }
  const withAccept: SceneGenerationExecution = {
    ...acceptedExecution,
    state: 'pending',
    replies: [acceptReply],
    pendingReply: acceptReply,
    interaction: undefined
  }
  await h.executions.writeExecution(withAccept)

  const workflowRef: { current?: PiSceneGenerationWorkflow } = {}
  let correctionRuns = 0
  const correcting = h.newWorkflow(
    {
      async run(request: PiAgentRunRequest): Promise<PiAgentRunResult> {
        correctionRuns += 1
        const write = request.tools.find((tool) => tool.name === 'writeCandidate')
        if (!write) throw new Error('缺少写工具')
        const revision = /"revision"\s*:\s*"([^"]+)"/.exec(String(request.prompt))?.[1]
        await write.execute(
          'call-repair',
          { path: entryPath, expectedRevision: revision, content: revisedScript },
          request.signal
        )
        // 修正轮已经写成、复核将判定可提交；此时才受理暂停。
        contentJudgment = 'acceptable'
        await workflowRef.current!.requestPauseAtSafeCheckpoint(withAccept)
        return succeeded()
      }
    } as unknown as PiAgentExecutor,
    domain
  )
  workflowRef.current = correcting
  contentJudgment = 'correctable'
  const pausedOutcome = await correcting.continueInteraction(runtimeOf(withAccept))
  expect(correctionRuns).toBe(1)
  expect(pausedOutcome.state).toBe('interrupted')
  if (pausedOutcome.state !== 'interrupted') throw new Error('expected interrupted')
  expect(pausedOutcome.interruptReason).toBe('paused')
  const pausedCandidate = pausedOutcome.candidateSnapshotId!
  expect(pausedCandidate).not.toBe(acceptedCandidate)

  const boundary = await readPauseBoundary(h.stateRoot, withAccept)
  if (!boundary) throw new Error('缺少暂停边界')
  // 接受语义与轮次必须保留：pass=1、首轮就是 repair，账本 repair-0 不被 generate-0 冒充。
  expect(boundary).toMatchObject({
    pass: 1,
    firstMode: 'repair',
    mode: 'repair',
    reviewAccepted: true,
    candidateSnapshotId: pausedCandidate,
    baseCandidateSnapshotId: acceptedCandidate
  })
  expect(
    (await readDurableEffects(h.stateRoot, withAccept)).map((effect) => [
      effect.stepId,
      effect.status
    ])
  ).toEqual([
    ['generate-0', 'completed'],
    ['repair-0', 'completed']
  ])

  const pausedExecution: SceneGenerationExecution = {
    ...withAccept,
    state: 'interrupted',
    interruptReason: 'paused',
    step: undefined,
    interaction: undefined,
    pendingReply: undefined,
    pauseRequested: false,
    checkpointId: pausedOutcome.checkpointId,
    candidateSnapshotId: pausedCandidate,
    budget: pausedOutcome.budget
  }
  await h.executions.writeExecution(pausedExecution)

  // 重开：新工作流实例只读边界并重新判定，已接受候选无需再次调用模型。
  let resumeRuns = 0
  const resuming = h.newWorkflow(
    {
      async run(): Promise<PiAgentRunResult> {
        resumeRuns += 1
        throw new Error('接受后的可提交边界不应再次调用模型')
      }
    } as unknown as PiAgentExecutor,
    domain
  )
  const resumed = await resuming.resumeGeneration(
    runtimeOf({
      ...pausedExecution,
      state: 'running',
      step: 'preparing',
      attempt: pausedExecution.attempt + 1,
      interruptReason: undefined
    })
  )
  expect(resumeRuns).toBe(0)
  expect(resumed.state).toBe('ready')
  expect(resumed.candidateSnapshotId).toBe(pausedCandidate)
  expect(await readFile(h.entry, 'utf8')).toBe(revisedScript)
  expect(boundary.reviewAccepted).toBe(true)
}, 30000)

it('暂停后撤销旧执行写资格，迟到的写工具调用不能覆盖草稿', async () => {
  const { h, firstTools, paused } = await pausedHarness()
  const before = await readFile(h.entry, 'utf8')
  const write = firstTools.find((tool) => tool.name === 'writeCandidate')
  if (!write) throw new Error('缺少旧写工具')
  await expect(
    write.execute(
      'late-write',
      {
        path: entryPath,
        expectedRevision: createHash('sha256').update(before).digest('hex'),
        content: 'say:迟到 -clear;'
      },
      new AbortController().signal
    )
  ).rejects.toThrow('旧执行已失去候选写入资格')
  expect(await readFile(h.entry, 'utf8')).toBe(before)
  const effects = await readDurableEffects(h.stateRoot, paused)
  expect(effects.filter((effect) => effect.status === 'started')).toEqual([])
})

it('暂停后草稿变化时拒绝继续，不调用模型也不写候选', async () => {
  const { h, paused } = await pausedHarness()
  await writeFile(h.entry, 'say:作者手改 -clear;')
  let runs = 0
  const workflow = h.newWorkflow({
    async run(): Promise<PiAgentRunResult> {
      runs += 1
      return succeeded()
    }
  } as unknown as PiAgentExecutor)
  const resumedExecution: SceneGenerationExecution = {
    ...paused,
    state: 'running',
    step: 'preparing',
    attempt: paused.attempt + 1,
    interruptReason: undefined
  }
  await expect(workflow.resumeGeneration(runtimeOf(resumedExecution))).rejects.toThrow(
    '草稿已变化，不能从暂停点继续'
  )
  expect(runs).toBe(0)
  expect(await readFile(h.entry, 'utf8')).toBe('say:作者手改 -clear;')
})

it('在途写入回执不明时保持待核对，不再调用模型或补写候选', async () => {
  const { h, paused } = await pausedHarness()
  // 模拟写入意图已落盘、完成记录未写出就崩溃：保留 started，不猜结果。
  await writeDurableEffect(h.stateRoot, paused, {
    operationId: paused.operationId,
    stepId: 'repair-1',
    inputDigest: 'unknown-input',
    status: 'started',
    kind: 'fileWrite'
  })
  let runs = 0
  const workflow = h.newWorkflow({
    async run(): Promise<PiAgentRunResult> {
      runs += 1
      return succeeded()
    }
  } as unknown as PiAgentExecutor)
  const resumedExecution: SceneGenerationExecution = {
    ...paused,
    state: 'running',
    step: 'preparing',
    attempt: paused.attempt + 1,
    interruptReason: undefined
  }
  await expect(workflow.resumeGeneration(runtimeOf(resumedExecution))).rejects.toThrow(
    '候选写入回执不明，已保留记录待核对'
  )
  expect(runs).toBe(0)
  const effects = await readDurableEffects(h.stateRoot, paused)
  expect(effects).toContainEqual(
    expect.objectContaining({ stepId: 'repair-1', status: 'started' })
  )
  expect(await readFile(h.entry, 'utf8')).toBe(correctableScript)
})

it('暂停期间保留的修改回复显式继续时只重放已完成写入，不重复写文件', async () => {
  const { h, paused, boundary } = await pausedHarness()
  // 把暂停事实改造成“提出修改回复已写出候选，但下一轮尚未开始”。
  const reply = {
    projectId: paused.projectId,
    sceneId: paused.sceneId,
    operationId: paused.operationId,
    threadId: paused.threadId,
    branchId: paused.branchId,
    interactionId: 'interaction-revise',
    checkpointId: paused.checkpointId!,
    replyId: 'reply-revise',
    reply: { kind: 'revise' as const, body: '把背景换成医务室' }
  }
  const withReply: SceneGenerationExecution = {
    ...paused,
    replies: [reply],
    pendingReply: reply,
    interaction: undefined
  }
  await h.executions.writeExecution(withReply)
  // 现有写入由 generate-0 变成与回复标记一致的 repair-0-<tag>；账本仍只有一条已完成记录。
  const tag = createHash('sha256').update(reply.replyId).digest('hex').slice(0, 16)
  const replyInputDigest = candidateInputDigest('repair', {
    ...withReply,
    candidateSnapshotId: paused.candidateSnapshotId
  })
  await writeDurableEffect(h.stateRoot, withReply, {
    operationId: paused.operationId,
    stepId: `repair-0-${tag}`,
    inputDigest: replyInputDigest,
    status: 'completed',
    kind: 'fileWrite',
    resultDigest: paused.candidateSnapshotId,
    candidateRevision: paused.candidateSnapshotId
  })
  // 修改暂停边界以匹配回复轮次。
  const updatedBoundary: PiPauseBoundary = {
    ...boundary,
    pass: 1,
    firstMode: 'repair',
    mode: 'repair',
    inputDigest: replyInputDigest,
    pendingReplyId: reply.replyId,
    baseCandidateSnapshotId: paused.candidateSnapshotId
  }
  await writePauseBoundary(h.stateRoot, updatedBoundary)

  let runs = 0
  const workflow = h.newWorkflow({
    async run(): Promise<PiAgentRunResult> {
      runs += 1
      // 已完成写入应被复用；进入下一轮修改后才允许调用模型。
      return succeeded()
    }
  } as unknown as PiAgentExecutor)
  const resumedExecution: SceneGenerationExecution = {
    ...withReply,
    state: 'running',
    step: 'preparing',
    attempt: withReply.attempt + 1,
    interruptReason: undefined
  }
  await workflow.resumeGeneration(runtimeOf(resumedExecution))
  // 已完成的写入不重放，只允许从下一轮继续；模型本轮没有写入，回到修正等待。
  expect(runs).toBe(1)
  const tagged = (await readDurableEffects(h.stateRoot, withReply)).filter((effect) =>
    effect.stepId.endsWith(tag)
  )
  expect(tagged).toHaveLength(1)
  expect(tagged[0]).toMatchObject({ stepId: `repair-0-${tag}`, status: 'completed' })
  expect(await readFile(h.entry, 'utf8')).toBe(correctableScript)
})

function domainOf(): SceneGenerationDomainService {
  return {
    evaluateResult(report: SceneValidationReport) {
      return { status: report.issues.length > 0 ? 'correctable' : 'acceptable', report }
    }
  } as unknown as SceneGenerationDomainService
}

function candidateOf(
  candidateSnapshotId: string,
  content: string
): SceneGenerationCandidate {
  const issues = content.includes('missing.svg')
    ? [
        {
          code: 'missing-asset' as SceneValidationIssueCode,
          message: '候选引用的素材不存在',
          correctable: true,
          requiresHumanDecision: false
        }
      ]
    : []
  return {
    candidateSnapshotId,
    artifact: {
      scene: { projectId: 'project', sceneId: 'scene' },
      hasEntry: true,
      statements: []
    },
    preview: {
      entryFile: entryPath,
      files: [],
      parserVersion: 'test',
      commandLocations: [],
      assetLocations: [],
      validationReport: { issues }
    },
    assetChanges: []
  }
}

function executionOf(workspaceRoot: string): SceneGenerationExecution {
  return {
    projectId: 'project',
    sceneId: 'scene',
    operationId: 'operation',
    threadId: 'thread',
    branchId: 'branch',
    fingerprint: 'fingerprint',
    source: {
      projectId: 'project',
      sceneId: 'scene',
      projectRoot: join(workspaceRoot, '..', 'project'),
      sceneDirectory: 'game/scene',
      entryFile: 'start.txt'
    },
    inputSnapshot: {
      canvasId: 'canvas',
      arrangementVersion: 'version',
      assets: [],
      documents: [],
      prompts: [],
      fieldBindings: [],
      relations: [],
      confirmedControls: []
    },
    policy: { maxCorrections: 2 },
    reviewCandidate: true,
    baseline: { commitId: 'baseline', affectedFiles: [], lockState: 'unlocked' },
    state: 'running',
    step: 'generating',
    attempt: 0,
    sequence: 0,
    budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 },
    mode: 'generate',
    replies: [],
    workspace: {
      workspaceId: 'operation',
      rootDirectory: workspaceRoot,
      sceneDirectory: 'game/scene'
    }
  }
}

function runtimeOf(execution: SceneGenerationExecution): SceneGenerationRuntime {
  const progress: SceneGenerationWorkflowProgress[] = []
  return {
    execution,
    signal: new AbortController().signal,
    userAbortSignal: new AbortController().signal,
    activeTimeoutSignal: AbortSignal.any([]),
    async publishProgress(event) {
      progress.push(event)
      return execution
    },
    async recordCandidateRevision() {
      return execution
    },
    async recordFailure() {
      return execution
    }
  }
}

function succeeded(): PiAgentRunResult {
  return {
    status: 'succeeded',
    stopReason: 'stop',
    messages: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    },
    durationMs: 1
  }
}
