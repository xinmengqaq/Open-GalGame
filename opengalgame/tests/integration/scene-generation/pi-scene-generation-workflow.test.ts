import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type {
  PiAgentExecutor,
  PiAgentRunRequest,
  PiAgentRunResult
} from '@infrastructure/ai/pi/PiAgentExecutor'
import type { FilePromptLoader } from '@infrastructure/ai/prompts/FilePromptLoader'
import type { FileSkillLoader } from '@infrastructure/ai/skills/FileSkillLoader'
import type { SceneArtifactGateway } from '@application/scene-generation/ports/SceneArtifactGateway'
import type {
  SceneGenerationDependencies,
  SceneGenerationCoordinator
} from '@application/scene-generation/services/impl/SceneGenerationCoordinator'
import type { SceneGenerationRenderDependencies } from '@application/scene-generation/services/impl/SceneGenerationRenderDependencies'
import { OpenSceneGenerationCandidatePreviewUseCase } from '@application/scene-generation/services/impl/OpenSceneGenerationCandidatePreviewUseCase'
import type { SceneGenerationDomainService } from '@domain/scene-generation/services/SceneGenerationDomainService'
import { SceneGenerationDomainServiceImpl } from '@domain/scene-generation/services/impl/SceneGenerationDomainServiceImpl'
import type {
  SceneGenerationCandidate,
  SceneGenerationExecution,
  SceneGenerationRuntime,
  SceneGenerationWorkflowProgress
} from '@application/scene-generation/models/SceneGenerationExecution'
import type { ReplySceneGenerationInteractionDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type {
  SceneValidationIssueCode,
  SceneValidationReport
} from '@domain/scene-generation/models/SceneValidationReport'
import { PiSceneGenerationWorkflow } from '@infrastructure/scene-generation/pi/PiSceneGenerationWorkflow'
import { candidateInputDigest } from '@infrastructure/scene-generation/workflow/graph/candidateRevision'
import { piReviewCheckpointId } from '@infrastructure/scene-generation/workflow/piReviewCheckpoint'
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

it('工具回执与宿主读回不一致时不保存候选修订', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-workflow-readback-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  const entry = join(workspaceRoot, 'game/scene/start.txt')
  await mkdir(join(workspaceRoot, 'game/scene'), { recursive: true })
  await writeFile(entry, 'say:种子 -clear;')
  const execution = executionOf(workspaceRoot)
  const progress: SceneGenerationWorkflowProgress[] = []
  const revisions: string[] = []
  const runtime = runtimeOf(execution, progress, revisions)
  let saveCalls = 0

  const staleAgent = {
    async run(request: PiAgentRunRequest): Promise<PiAgentRunResult> {
      const write = request.tools.find((tool) => tool.name === 'writeCandidate')
      if (!write) throw new Error('缺少写工具')
      const revision = /"revision"\s*:\s*"([^"]+)"/.exec(String(request.prompt))?.[1]
      await write.execute(
        'call-write',
        {
          path: 'game/scene/start.txt',
          expectedRevision: revision,
          content: 'say:工具回执 -clear;'
        },
        request.signal
      )
      // 模拟工具返回后文件被另一写入者改动，宿主读回摘要必须拒绝发布。
      await writeFile(entry, 'say:迟到覆盖 -clear;')
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
  } as unknown as PiAgentExecutor

  const workflow = new PiSceneGenerationWorkflow({
    artifacts: {
      async readCandidate() {
        throw new Error('不应进入候选读取')
      },
      async saveCandidateRevision() {
        saveCalls += 1
        return { candidateSnapshotId: 'a'.repeat(40) }
      }
    } satisfies Pick<SceneArtifactGateway, 'readCandidate' | 'saveCandidateRevision'>,
    versions: {
      async inspectBaseline() {
        return { baselineState: 'unchanged' as const, lockState: 'unlocked' as const }
      }
    },
    domain: {} as SceneGenerationDomainService,
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
    stateRoot: join(root, 'state'),
    createAgent: async () => staleAgent,
    nextId: () => 'next-id',
    now: () => 1
  })

  await expect(workflow.executeGeneration(runtime)).rejects.toThrow('候选回读摘要与工具回执不一致')
  expect(saveCalls).toBe(0)
  expect(revisions).toEqual([])
  expect(progress.some((event) => event.artifactValidation !== undefined)).toBe(false)
})

it('修正轮没有写入时沿用上一轮真实诊断，不能进入预览', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-workflow-no-write-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  const entry = join(workspaceRoot, 'game/scene/start.txt')
  await mkdir(join(workspaceRoot, 'game/scene'), { recursive: true })
  await writeFile(entry, 'say:种子 -clear;')
  const execution = executionOf(workspaceRoot)
  const progress: SceneGenerationWorkflowProgress[] = []
  const revisions: string[] = []
  const runtime = runtimeOf(execution, progress, revisions)
  let runs = 0
  const agent = {
    async run(request: PiAgentRunRequest): Promise<PiAgentRunResult> {
      runs += 1
      if (runs === 1) {
        const write = request.tools.find((tool) => tool.name === 'writeCandidate')
        if (!write) throw new Error('缺少写工具')
        const revision = /"revision"\s*:\s*"([^"]+)"/.exec(String(request.prompt))?.[1]
        await write.execute(
          'call-write',
          {
            path: 'game/scene/start.txt',
            expectedRevision: revision,
            content: 'changeBg:missing.svg;\nsay:台词 -clear;\nend;'
          },
          request.signal
        )
      }
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
  } as unknown as PiAgentExecutor
  const candidate = {
    candidateSnapshotId: 'a'.repeat(40),
    artifact: {
      scene: { projectId: 'project', sceneId: 'scene' },
      hasEntry: true,
      statements: []
    },
    preview: {
      entryFile: 'game/scene/start.txt',
      files: [],
      parserVersion: 'test',
      commandLocations: [],
      assetLocations: [],
      validationReport: {
        issues: [
          {
            code: 'missing-asset',
            message: '候选引用的素材不存在',
            correctable: true,
            requiresHumanDecision: false
          }
        ]
      }
    },
    assetChanges: []
  }
  const workflow = new PiSceneGenerationWorkflow({
    artifacts: {
      async readCandidate() {
        return candidate
      },
      async saveCandidateRevision() {
        return { candidateSnapshotId: candidate.candidateSnapshotId }
      }
    },
    versions: {
      async inspectBaseline() {
        return { baselineState: 'unchanged' as const, lockState: 'unlocked' as const }
      }
    },
    domain: new SceneGenerationDomainServiceImpl(),
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
    stateRoot: join(root, 'state'),
    createAgent: async () => agent,
    nextId: () => 'next-id',
    now: () => 1
  })

  const outcome = await workflow.executeGeneration(runtime)
  expect(runs).toBe(2)
  expect(outcome.state).toBe('waiting')
  if (outcome.state !== 'waiting') throw new Error('应停留在修正等待')
  expect(outcome.interaction.kind).toBe('correction')
  expect(outcome.interaction.allowedReplies).toEqual(['revise', 'discard'])
  expect(outcome.interaction.message).not.toContain('当前构建')
  const reported = progress.filter((event) => event.artifactValidation !== undefined).at(-1)
  expect(reported?.artifactValidation?.issues.map((issue) => issue.code)).toEqual(['missing-asset'])
  expect(revisions).toEqual([candidate.candidateSnapshotId])
  // 无写入的修正轮不留下 started 伪意图；只有真实写出的一轮有完成记录。
  const effects = await readDurableEffects(join(root, 'state'), execution)
  expect(effects).toHaveLength(1)
  expect(effects[0]).toMatchObject({
    stepId: 'generate-0',
    status: 'completed',
    candidateRevision: candidate.candidateSnapshotId
  })
  // 授权正文只来自当前输入快照，不进入候选工作区或修订。
  await expect(access(join(workspaceRoot, '.opengalgame/authorized-inputs'))).rejects.toMatchObject(
    {
      code: 'ENOENT'
    }
  )

  const waitingExecution: SceneGenerationExecution = {
    ...execution,
    state: 'waiting',
    checkpointId: outcome.checkpointId,
    candidateSnapshotId: candidate.candidateSnapshotId,
    interaction: outcome.interaction,
    artifactValidation: reported!.artifactValidation
  }
  let opened = 0
  const preview = new OpenSceneGenerationCandidatePreviewUseCase(
    {
      deps: {
        history: {
          listHistory: async () => ({ branches: [], checkpoints: [] })
        }
      } as unknown as SceneGenerationDependencies,
      coordinator: {
        requireExecution: async () => waitingExecution
      } as unknown as SceneGenerationCoordinator
    },
    {
      preview: {
        openPublishedCandidatePreview: async () => {
          opened += 1
          throw new Error('不应打开预览')
        }
      }
    } as unknown as SceneGenerationRenderDependencies
  )
  await expect(
    preview.openSceneGenerationCandidatePreview({
      projectId: 'project',
      sceneId: 'scene',
      operationId: 'operation',
      threadId: 'thread',
      branchId: 'branch',
      checkpointId: outcome.checkpointId,
      candidateSnapshotId: candidate.candidateSnapshotId
    })
  ).rejects.toThrow('候选尚未通过生成校验')
  expect(opened).toBe(0)
})

it('写后取消先保留修订与完成记录，再以取消结束', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-workflow-post-write-cancel-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  const entry = join(workspaceRoot, 'game/scene/start.txt')
  await mkdir(join(workspaceRoot, 'game/scene'), { recursive: true })
  await writeFile(entry, 'say:种子 -clear;')
  const execution = executionOf(workspaceRoot)
  const controller = new AbortController()
  const progress: SceneGenerationWorkflowProgress[] = []
  const revisions: string[] = []
  const runtime = runtimeOf(execution, progress, revisions, controller)
  const candidate = {
    candidateSnapshotId: 'b'.repeat(40),
    artifact: {
      scene: { projectId: 'project', sceneId: 'scene' },
      hasEntry: true,
      statements: []
    },
    preview: {
      entryFile: 'game/scene/start.txt',
      files: [],
      parserVersion: 'test',
      commandLocations: [],
      assetLocations: [],
      validationReport: { issues: [] }
    },
    assetChanges: []
  }
  const agent = {
    async run(request: PiAgentRunRequest): Promise<PiAgentRunResult> {
      const write = request.tools.find((tool) => tool.name === 'writeCandidate')
      if (!write) throw new Error('缺少写工具')
      const revision = /"revision"\s*:\s*"([^"]+)"/.exec(String(request.prompt))?.[1]
      await write.execute(
        'call-write',
        {
          path: 'game/scene/start.txt',
          expectedRevision: revision,
          content: 'say:写后取消 -clear;'
        },
        request.signal
      )
      controller.abort()
      return {
        status: 'cancelled',
        stopReason: 'aborted',
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
  } as unknown as PiAgentExecutor
  const workflow = new PiSceneGenerationWorkflow({
    artifacts: {
      async readCandidate() {
        return candidate
      },
      async saveCandidateRevision() {
        return { candidateSnapshotId: candidate.candidateSnapshotId }
      }
    },
    versions: {
      async inspectBaseline() {
        return { baselineState: 'unchanged' as const, lockState: 'unlocked' as const }
      }
    },
    domain: new SceneGenerationDomainServiceImpl(),
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
    stateRoot: join(root, 'state'),
    createAgent: async () => agent,
    nextId: () => 'next-id',
    now: () => 1
  })

  await expect(workflow.executeGeneration(runtime)).rejects.toThrow('执行已取消')
  expect(revisions).toEqual([candidate.candidateSnapshotId])
  const effects = await readDurableEffects(join(root, 'state'), execution)
  expect(effects).toEqual([
    expect.objectContaining({
      stepId: 'generate-0',
      status: 'completed',
      candidateRevision: candidate.candidateSnapshotId
    })
  ])
})

it('暂停、继续与历史分叉可用；没有已持久接受的等待时继续回复被拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-workflow-unavailable-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  await mkdir(join(workspaceRoot, 'game/scene'), { recursive: true })
  const execution = executionOf(workspaceRoot)
  const runtime = runtimeOf(execution, [], [])
  const workflow = new PiSceneGenerationWorkflow({
    artifacts: {} as Pick<SceneArtifactGateway, 'readCandidate' | 'saveCandidateRevision'>,
    versions: {} as never,
    domain: {} as SceneGenerationDomainService,
    prompts: {} as FilePromptLoader,
    skills: {} as FileSkillLoader,
    stateRoot: join(root, 'state'),
    createAgent: async () => {
      throw new Error('不应创建模型')
    },
    nextId: () => 'next-id'
  })
  expect(workflow.capabilities()).toEqual({
    resume: true,
    pause: true,
    continueInteraction: true,
    fork: true
  })
  await expect(workflow.resumeGeneration(runtime)).rejects.toThrow('当前操作没有可复核的候选修订')
  await expect(workflow.continueInteraction(runtime)).rejects.toThrow('当前没有可继续的人工回复')
  await expect(workflow.forkGeneration(runtime, {} as never)).rejects.toThrow(
    '当前操作不是带来源身份的分叉执行'
  )
})

it('接受当前修订只重读候选并返回可提交结果，不创建模型', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-workflow-accept-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  await mkdir(join(workspaceRoot, 'game/scene'), { recursive: true })
  await writeFile(join(workspaceRoot, 'game/scene/start.txt'), 'say:候选 -clear;')
  const candidateSnapshotId = 'a'.repeat(40)
  const checkpointId = piReviewCheckpointId('operation', candidateSnapshotId)
  const reply = {
    projectId: 'project',
    sceneId: 'scene',
    operationId: 'operation',
    threadId: 'thread',
    branchId: 'branch',
    interactionId: 'interaction-accept',
    checkpointId,
    candidateSnapshotId,
    replyId: 'reply-accept',
    reply: { kind: 'accept' as const }
  }
  const execution: SceneGenerationExecution = {
    ...executionOf(workspaceRoot),
    state: 'running',
    checkpointId,
    candidateSnapshotId,
    interaction: {
      interactionId: reply.interactionId,
      checkpointId,
      kind: 'review',
      message: '请审阅当前候选。',
      options: [],
      allowedReplies: ['accept', 'revise', 'discard'],
      candidateSnapshotId
    },
    replies: [reply],
    pendingReply: reply
  }
  const progress: SceneGenerationWorkflowProgress[] = []
  const revisions: string[] = []
  const workflow = new PiSceneGenerationWorkflow({
    artifacts: {
      async readCandidate(_execution, id) {
        return candidateOf(id, [])
      },
      async saveCandidateRevision() {
        throw new Error('接受只提交既有修订，不应保存新修订')
      }
    },
    versions: {
      async inspectBaseline() {
        throw new Error('接受时不重新读取基线；提交网关负责复验')
      }
    },
    domain: new SceneGenerationDomainServiceImpl(),
    prompts: {} as FilePromptLoader,
    skills: {} as FileSkillLoader,
    stateRoot: join(root, 'state'),
    createAgent: async () => {
      throw new Error('接受不应创建模型')
    },
    nextId: () => 'next-id',
    now: () => 1
  })
  const outcome = await workflow.continueInteraction(runtimeOf(execution, progress, revisions))
  expect(outcome.state).toBe('ready')
  if (outcome.state !== 'ready') throw new Error('接受后应进入可提交状态')
  expect(outcome.candidateSnapshotId).toBe(candidateSnapshotId)
  expect(outcome.checkpointId).toBe(checkpointId)
  expect(progress.at(-1)).toMatchObject({
    step: 'validating',
    candidateSnapshotId,
    artifactValidation: { issues: [] }
  })
  expect(revisions).toEqual([])
})

it('提出修改在当前候选上执行修改轮，重置修正次数并重新进入审阅', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-workflow-revise-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  const entry = join(workspaceRoot, 'game/scene/start.txt')
  await mkdir(join(workspaceRoot, 'game/scene'), { recursive: true })
  await writeFile(entry, 'say:旧候选 -clear;')
  const previousSnapshotId = 'a'.repeat(40)
  const revisedSnapshotId = 'b'.repeat(40)
  const checkpointId = piReviewCheckpointId('operation', previousSnapshotId)
  const reply = {
    projectId: 'project',
    sceneId: 'scene',
    operationId: 'operation',
    threadId: 'thread',
    branchId: 'branch',
    interactionId: 'interaction-revise',
    checkpointId,
    candidateSnapshotId: previousSnapshotId,
    replyId: 'reply-revise',
    reply: { kind: 'revise' as const, body: '把道别改成明天再见' }
  }
  const execution: SceneGenerationExecution = {
    ...executionOf(workspaceRoot),
    state: 'running',
    checkpointId,
    candidateSnapshotId: previousSnapshotId,
    interaction: {
      interactionId: reply.interactionId,
      checkpointId,
      kind: 'review',
      message: '请审阅当前候选。',
      options: [],
      allowedReplies: ['accept', 'revise', 'discard'],
      candidateSnapshotId: previousSnapshotId
    },
    replies: [reply],
    pendingReply: reply,
    budget: { ...executionOf(workspaceRoot).budget, correctionsUsed: 1 }
  }
  const progress: SceneGenerationWorkflowProgress[] = []
  const revisions: string[] = []
  let prompt = ''
  let toolNames: string[] = []
  const agent = {
    async run(request: PiAgentRunRequest): Promise<PiAgentRunResult> {
      prompt = String(request.prompt)
      toolNames = request.tools.map((tool) => tool.name)
      const write = request.tools.find((tool) => tool.name === 'writeCandidate')
      if (!write) throw new Error('缺少写工具')
      const revision = /"revision"\s*:\s*"([^"]+)"/.exec(prompt)?.[1]
      await write.execute(
        'call-write',
        {
          path: 'game/scene/start.txt',
          expectedRevision: revision,
          content: 'say:明天再见 -clear;'
        },
        request.signal
      )
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
  } as unknown as PiAgentExecutor
  const workflow = new PiSceneGenerationWorkflow({
    artifacts: {
      async readCandidate(_execution, id) {
        return candidateOf(id, [])
      },
      async saveCandidateRevision() {
        return { candidateSnapshotId: revisedSnapshotId }
      }
    },
    versions: {
      async inspectBaseline() {
        return { baselineState: 'unchanged' as const, lockState: 'unlocked' as const }
      }
    },
    domain: new SceneGenerationDomainServiceImpl(),
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
    stateRoot: join(root, 'state'),
    createAgent: async () => agent,
    nextId: () => 'next-id',
    now: () => 1
  })
  const outcome = await workflow.continueInteraction(runtimeOf(execution, progress, revisions))
  expect(outcome.state).toBe('waiting')
  if (outcome.state !== 'waiting') throw new Error('修改轮后应重新进入审阅')
  expect(outcome.candidateSnapshotId).toBe(revisedSnapshotId)
  expect(outcome.interaction).toMatchObject({
    kind: 'review',
    allowedReplies: ['accept', 'revise', 'discard'],
    candidateSnapshotId: revisedSnapshotId
  })
  expect(outcome.interaction.message).not.toContain('当前构建')
  expect(outcome.budget.correctionsUsed).toBe(0)
  expect(prompt).toContain('把道别改成明天再见')
  expect(prompt).toContain('"mode":"repair"')
  expect(prompt).toContain('"repairKind":"author"')
  expect(prompt).toContain('"authorRevision"')
  expect(prompt).toContain('只修改作者点名内容及其必要关联')
  // 修复轮不提供写前追问，避免在已有候选上覆盖或重开题组。
  expect(toolNames).not.toContain('requestClarification')
  expect(revisions).toEqual([revisedSnapshotId])
  const effects = await readDurableEffects(join(root, 'state'), execution)
  expect(effects).toHaveLength(1)
  expect(effects[0]).toMatchObject({
    status: 'completed',
    candidateRevision: revisedSnapshotId,
    stepId: expect.stringMatching(/^repair-0-[a-f0-9]{16}$/)
  })
})

it('重启后已完成的修改轮直接复用修订，不创建模型或重复写入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-workflow-replay-completed-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  await mkdir(join(workspaceRoot, 'game/scene'), { recursive: true })
  await writeFile(join(workspaceRoot, 'game/scene/start.txt'), 'say:已完成修改 -clear;')
  const previousSnapshotId = 'a'.repeat(40)
  const revisedSnapshotId = 'b'.repeat(40)
  const checkpointId = piReviewCheckpointId('operation', previousSnapshotId)
  const reply = {
    projectId: 'project',
    sceneId: 'scene',
    operationId: 'operation',
    threadId: 'thread',
    branchId: 'branch',
    interactionId: 'interaction-replay',
    checkpointId,
    candidateSnapshotId: previousSnapshotId,
    replyId: 'reply-replay',
    reply: { kind: 'revise' as const, body: '只把结尾改成明天见' }
  }
  const execution: SceneGenerationExecution = {
    ...executionOf(workspaceRoot),
    state: 'running',
    checkpointId,
    candidateSnapshotId: revisedSnapshotId,
    replies: [reply],
    pendingReply: reply
  }
  const tag = createHash('sha256').update(reply.replyId).digest('hex').slice(0, 16)
  await writeDurableEffect(join(root, 'state'), execution, {
    operationId: execution.operationId,
    stepId: `repair-0-${tag}`,
    inputDigest: candidateInputDigest('repair', {
      ...execution,
      candidateSnapshotId: previousSnapshotId
    }),
    status: 'completed',
    kind: 'fileWrite',
    candidateRevision: revisedSnapshotId,
    resultDigest: revisedSnapshotId
  })
  let agentCalls = 0
  const workflow = new PiSceneGenerationWorkflow({
    artifacts: {
      async readCandidate(_execution, id) {
        return candidateOf(id, [])
      },
      async saveCandidateRevision() {
        throw new Error('重放已完成修订时不应再次保存')
      }
    },
    versions: {
      async inspectBaseline() {
        return { baselineState: 'unchanged' as const, lockState: 'unlocked' as const }
      }
    },
    domain: new SceneGenerationDomainServiceImpl(),
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
    stateRoot: join(root, 'state'),
    createAgent: async () => {
      agentCalls += 1
      throw new Error('重放已完成修订时不应创建模型')
    },
    nextId: () => 'next-id',
    now: () => 1
  })
  const outcome = await workflow.continueInteraction(runtimeOf(execution, [], []))
  expect(agentCalls).toBe(0)
  expect(outcome.state).toBe('waiting')
  if (outcome.state !== 'waiting') throw new Error('重放后应重新进入审阅')
  expect(outcome.candidateSnapshotId).toBe(revisedSnapshotId)
  expect(outcome.interaction.allowedReplies).toEqual(['accept', 'revise', 'discard'])
  expect(outcome.budget.correctionsUsed).toBe(0)
  const effects = await readDurableEffects(join(root, 'state'), execution)
  expect(effects).toHaveLength(1)
  expect(effects[0]).toMatchObject({ status: 'completed', candidateRevision: revisedSnapshotId })
})

it('重启时修改写入结果不明则停止重放，不重跑模型', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-workflow-replay-unknown-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  await mkdir(join(workspaceRoot, 'game/scene'), { recursive: true })
  await writeFile(join(workspaceRoot, 'game/scene/start.txt'), 'say:未知写入 -clear;')
  const previousSnapshotId = 'a'.repeat(40)
  const checkpointId = piReviewCheckpointId('operation', previousSnapshotId)
  const reply = {
    projectId: 'project',
    sceneId: 'scene',
    operationId: 'operation',
    threadId: 'thread',
    branchId: 'branch',
    interactionId: 'interaction-unknown',
    checkpointId,
    candidateSnapshotId: previousSnapshotId,
    replyId: 'reply-unknown',
    reply: { kind: 'revise' as const, body: '改写结尾' }
  }
  const execution: SceneGenerationExecution = {
    ...executionOf(workspaceRoot),
    state: 'running',
    checkpointId,
    candidateSnapshotId: previousSnapshotId,
    replies: [reply],
    pendingReply: reply
  }
  const tag = createHash('sha256').update(reply.replyId).digest('hex').slice(0, 16)
  await writeDurableEffect(join(root, 'state'), execution, {
    operationId: execution.operationId,
    stepId: `repair-0-${tag}`,
    inputDigest: candidateInputDigest('repair', execution),
    status: 'started',
    kind: 'fileWrite'
  })
  let agentCalls = 0
  const workflow = new PiSceneGenerationWorkflow({
    artifacts: {
      async readCandidate(_execution, id) {
        return candidateOf(id, [])
      },
      async saveCandidateRevision() {
        throw new Error('不明写入不应再次保存')
      }
    },
    versions: {} as never,
    domain: {} as SceneGenerationDomainService,
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
    stateRoot: join(root, 'state'),
    createAgent: async () => {
      agentCalls += 1
      throw new Error('不明写入不应创建模型')
    },
    nextId: () => 'next-id',
    now: () => 1
  })
  await expect(workflow.continueInteraction(runtimeOf(execution, [], []))).rejects.toThrow(
    '副作用结果不明'
  )
  expect(agentCalls).toBe(0)
})

it('写前题组只读等待，整组回答后在同一操作首次生成候选且不再出题', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-workflow-questions-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  const entry = join(workspaceRoot, 'game/scene/start.txt')
  await mkdir(join(workspaceRoot, 'game/scene'), { recursive: true })
  await writeFile(entry, 'say:种子 -clear;')
  const base = executionOf(workspaceRoot)
  const progress: SceneGenerationWorkflowProgress[] = []
  const revisions: string[] = []
  const prompts: string[] = []
  const toolNames: string[][] = []
  const candidateSnapshotId = 'a'.repeat(40)
  const questions = [
    {
      prompt: '主角此刻最想确认什么？',
      detail: '影响开场独白',
      options: [
        { label: '确认对方还在', description: '保留等待感' },
        { label: '确认自己该离开', description: '推动告别' },
        { label: '确认时间已到', description: '收紧节奏' }
      ]
    },
    {
      prompt: '结尾停在哪个动作？',
      options: [
        { label: '推门离开', description: '留出下一步' },
        { label: '回头', description: '保留犹豫' },
        { label: '沉默', description: '收在静止画面' }
      ]
    }
  ]
  const agent = {
    async run(request: PiAgentRunRequest): Promise<PiAgentRunResult> {
      prompts.push(String(request.prompt))
      toolNames.push(request.tools.map((tool) => tool.name))
      if (prompts.length === 1) {
        const ask = request.tools.find((tool) => tool.name === 'requestClarification')
        if (!ask) throw new Error('缺少提问工具')
        const asked = await ask.execute('call-ask', { questions }, request.signal)
        expect(asked.details).toMatchObject({
          questions: [
            { questionId: 'q1', options: [{ id: 'q1o1' }, { id: 'q1o2' }, { id: 'q1o3' }] },
            { questionId: 'q2', options: [{ id: 'q2o1' }, { id: 'q2o2' }, { id: 'q2o3' }] }
          ]
        })
        return succeededRun()
      }
      const write = request.tools.find((tool) => tool.name === 'writeCandidate')
      if (!write) throw new Error('缺少写工具')
      const revision = /"revision"\s*:\s*"([^"]+)"/.exec(String(request.prompt))?.[1]
      await write.execute(
        'call-write',
        {
          path: 'game/scene/start.txt',
          expectedRevision: revision,
          content: 'say:按回答生成 -clear;'
        },
        request.signal
      )
      return succeededRun()
    }
  } as unknown as PiAgentExecutor
  const workflow = new PiSceneGenerationWorkflow({
    artifacts: {
      async readCandidate(_execution, id) {
        return candidateOf(id, [])
      },
      async saveCandidateRevision() {
        return { candidateSnapshotId }
      }
    },
    versions: {
      async inspectBaseline() {
        return { baselineState: 'unchanged' as const, lockState: 'unlocked' as const }
      }
    },
    domain: new SceneGenerationDomainServiceImpl(),
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
    stateRoot: join(root, 'state'),
    createAgent: async () => agent,
    nextId: () => 'next-id',
    now: () => 1
  })

  const first = await workflow.executeGeneration(runtimeOf(base, progress, revisions))
  expect(first.state).toBe('waiting')
  if (first.state !== 'waiting') throw new Error('题组应停留在等待')
  expect(first.interaction).toMatchObject({
    kind: 'decision',
    allowedReplies: ['answers', 'discard'],
    checkpointId: piReviewCheckpointId('operation')
  })
  expect(first.interaction.questions).toHaveLength(2)
  expect(first.interaction.questions?.[0]).toMatchObject({
    questionId: 'q1',
    prompt: '主角此刻最想确认什么？',
    options: [{ id: 'q1o1', label: '确认对方还在' }, { id: 'q1o2' }, { id: 'q1o3' }]
  })
  expect(first.candidateSnapshotId).toBeUndefined()
  expect(first.checkpointId).toBe(piReviewCheckpointId('operation'))
  // 无候选、无修订、无文件写入：题组只作为等待事实。
  expect(revisions).toEqual([])
  expect(await readFile(entry, 'utf8')).toBe('say:种子 -clear;')
  expect(await readDurableEffects(join(root, 'state'), base)).toEqual([])
  expect(progress.every((event) => event.candidateSnapshotId === undefined)).toBe(true)
  expect(progress.every((event) => event.artifactValidation === undefined)).toBe(true)
  expect(toolNames[0]).toContain('requestClarification')

  const interaction = first.interaction
  const selections = interaction.questions!.map((question, index) => {
    const option = question.options[index % question.options.length]
    return {
      questionId: question.questionId,
      prompt: question.prompt,
      optionId: option.id,
      label: option.label,
      description: option.description,
      ...(index === 0 ? { body: '保留这个方向' } : {})
    }
  })
  const answerReply = {
    projectId: 'project',
    sceneId: 'scene',
    operationId: 'operation',
    threadId: 'thread',
    branchId: 'branch',
    interactionId: interaction.interactionId,
    checkpointId: interaction.checkpointId,
    replyId: 'reply-answers',
    reply: {
      kind: 'answers' as const,
      answers: selections.map((item, index) => ({
        questionId: item.questionId,
        optionId: item.optionId,
        ...(index === 0 ? { body: '保留这个方向' } : {})
      }))
    },
    selections
  }
  const continuation: SceneGenerationExecution = {
    ...base,
    state: 'pending',
    checkpointId: interaction.checkpointId,
    interaction,
    replies: [answerReply],
    pendingReply: answerReply
  }
  const secondProgress: SceneGenerationWorkflowProgress[] = []
  const secondRevisions: string[] = []
  const second = await workflow.continueInteraction(
    runtimeOf(continuation, secondProgress, secondRevisions)
  )
  expect(second.state).toBe('waiting')
  if (second.state !== 'waiting') throw new Error('回答后应重新进入审阅')
  expect(second.interaction).toMatchObject({
    kind: 'review',
    allowedReplies: ['accept', 'revise', 'discard'],
    candidateSnapshotId
  })
  expect(second.candidateSnapshotId).toBe(candidateSnapshotId)
  expect(secondRevisions).toEqual([candidateSnapshotId])
  // 回答后的新授权输入进入模型事实，且不再提供第二次提问。
  expect(toolNames[1]).not.toContain('requestClarification')
  expect(prompts[1]).toContain('"selections"')
  expect(prompts[1]).toContain('保留这个方向')
  const effects = await readDurableEffects(join(root, 'state'), continuation)
  expect(effects).toHaveLength(1)
  const answerTag = createHash('sha256').update('reply-answers').digest('hex').slice(0, 16)
  expect(effects[0]).toMatchObject({
    stepId: `generate-0-${answerTag}`,
    status: 'completed',
    candidateRevision: candidateSnapshotId
  })
  expect(effects[0].inputDigest).toBe(candidateInputDigest('generate', continuation))
  expect(effects[0].inputDigest).not.toBe(
    candidateInputDigest('generate', { ...continuation, replies: [] })
  )
})

it('重启后已完成的整组回答写入直接复用修订，两次结算都不重写或调用模型', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-workflow-answer-replay-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  const entry = join(workspaceRoot, 'game/scene/start.txt')
  await mkdir(join(workspaceRoot, 'game/scene'), { recursive: true })
  await writeFile(entry, 'say:按回答生成 -clear;')
  const candidateSnapshotId = 'c'.repeat(40)
  const execution = answeredExecutionOf(workspaceRoot, candidateSnapshotId)
  const tag = createHash('sha256').update('reply-answers').digest('hex').slice(0, 16)
  await writeDurableEffect(join(root, 'state'), execution, {
    operationId: execution.operationId,
    stepId: `generate-0-${tag}`,
    inputDigest: candidateInputDigest('generate', {
      ...execution,
      candidateSnapshotId: undefined
    }),
    status: 'completed',
    kind: 'fileWrite',
    candidateRevision: candidateSnapshotId,
    resultDigest: candidateSnapshotId
  })
  let agentCalls = 0
  const revisions: string[] = []
  const workflow = new PiSceneGenerationWorkflow({
    artifacts: {
      async readCandidate(_execution, id) {
        return candidateOf(id, [])
      },
      async saveCandidateRevision() {
        throw new Error('重放整组回答写入时不应再次保存')
      }
    },
    versions: {
      async inspectBaseline() {
        return { baselineState: 'unchanged' as const, lockState: 'unlocked' as const }
      }
    },
    domain: new SceneGenerationDomainServiceImpl(),
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
    stateRoot: join(root, 'state'),
    createAgent: async () => {
      agentCalls += 1
      throw new Error('重放整组回答写入时不应创建模型')
    },
    nextId: () => 'next-id',
    now: () => 1
  })
  const first = await workflow.continueInteraction(runtimeOf(execution, [], revisions))
  const second = await workflow.continueInteraction(runtimeOf(execution, [], revisions))
  for (const outcome of [first, second]) {
    expect(outcome.state).toBe('waiting')
    if (outcome.state !== 'waiting') throw new Error('重放后应重新进入审阅')
    expect(outcome.candidateSnapshotId).toBe(candidateSnapshotId)
    expect(outcome.interaction.allowedReplies).toEqual(['accept', 'revise', 'discard'])
  }
  expect(agentCalls).toBe(0)
  expect(revisions).toEqual([])
  const effects = await readDurableEffects(join(root, 'state'), execution)
  expect(effects).toHaveLength(1)
  expect(effects[0]).toMatchObject({
    stepId: `generate-0-${tag}`,
    status: 'completed',
    candidateRevision: candidateSnapshotId
  })
  expect(await readFile(entry, 'utf8')).toBe('say:按回答生成 -clear;')
})

it('整组回答只留下 started 时用已记录候选快照补一次完成记录，不重写候选', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-workflow-answer-started-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  const entry = join(workspaceRoot, 'game/scene/start.txt')
  await mkdir(join(workspaceRoot, 'game/scene'), { recursive: true })
  await writeFile(entry, 'say:按回答生成 -clear;')
  const candidateSnapshotId = 'd'.repeat(40)
  const execution = answeredExecutionOf(workspaceRoot, candidateSnapshotId)
  const tag = createHash('sha256').update('reply-answers').digest('hex').slice(0, 16)
  await writeDurableEffect(join(root, 'state'), execution, {
    operationId: execution.operationId,
    stepId: `generate-0-${tag}`,
    inputDigest: candidateInputDigest('generate', {
      ...execution,
      candidateSnapshotId: undefined
    }),
    status: 'started',
    kind: 'fileWrite'
  })
  let agentCalls = 0
  const revisions: string[] = []
  const workflow = new PiSceneGenerationWorkflow({
    artifacts: {
      async readCandidate(_execution, id) {
        return candidateOf(id, [])
      },
      async saveCandidateRevision() {
        throw new Error('补结算 started 时不应重新保存候选')
      }
    },
    versions: {
      async inspectBaseline() {
        return { baselineState: 'unchanged' as const, lockState: 'unlocked' as const }
      }
    },
    domain: new SceneGenerationDomainServiceImpl(),
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
    stateRoot: join(root, 'state'),
    createAgent: async () => {
      agentCalls += 1
      throw new Error('补结算 started 时不应创建模型')
    },
    nextId: () => 'next-id',
    now: () => 1
  })
  const outcome = await workflow.continueInteraction(runtimeOf(execution, [], revisions))
  expect(outcome.state).toBe('waiting')
  if (outcome.state !== 'waiting') throw new Error('补结算后应重新进入审阅')
  expect(outcome.candidateSnapshotId).toBe(candidateSnapshotId)
  expect(agentCalls).toBe(0)
  expect(revisions).toEqual([])
  const effects = await readDurableEffects(join(root, 'state'), execution)
  expect(effects).toHaveLength(1)
  expect(effects[0]).toMatchObject({
    stepId: `generate-0-${tag}`,
    status: 'completed',
    candidateRevision: candidateSnapshotId,
    resultDigest: candidateSnapshotId
  })
  // 再次结算仍只读取同一条完成记录，不追加记录或改写候选。
  await workflow.continueInteraction(runtimeOf(execution, [], revisions))
  expect(await readDurableEffects(join(root, 'state'), execution)).toHaveLength(1)
  expect(revisions).toEqual([])
  expect(await readFile(entry, 'utf8')).toBe('say:按回答生成 -clear;')
})

it('整组回答只有 started 且没有可归属候选时停止，不调用模型或盲写', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-workflow-answer-unknown-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  const entry = join(workspaceRoot, 'game/scene/start.txt')
  await mkdir(join(workspaceRoot, 'game/scene'), { recursive: true })
  await writeFile(entry, 'say:未知写入 -clear;')
  const execution = answeredExecutionOf(workspaceRoot, undefined)
  const tag = createHash('sha256').update('reply-answers').digest('hex').slice(0, 16)
  await writeDurableEffect(join(root, 'state'), execution, {
    operationId: execution.operationId,
    stepId: `generate-0-${tag}`,
    inputDigest: candidateInputDigest('generate', execution),
    status: 'started',
    kind: 'fileWrite'
  })
  let agentCalls = 0
  const revisions: string[] = []
  const workflow = new PiSceneGenerationWorkflow({
    artifacts: {
      async readCandidate() {
        throw new Error('回执不明时不应读取候选')
      },
      async saveCandidateRevision() {
        throw new Error('回执不明时不应保存候选')
      }
    },
    versions: {} as never,
    domain: {} as SceneGenerationDomainService,
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
    stateRoot: join(root, 'state'),
    createAgent: async () => {
      agentCalls += 1
      throw new Error('回执不明时不应创建模型')
    },
    nextId: () => 'next-id',
    now: () => 1
  })
  await expect(workflow.continueInteraction(runtimeOf(execution, [], revisions))).rejects.toThrow(
    '写入回执不明'
  )
  expect(agentCalls).toBe(0)
  expect(revisions).toEqual([])
  const effects = await readDurableEffects(join(root, 'state'), execution)
  expect(effects).toHaveLength(1)
  expect(effects[0].status).toBe('started')
  expect(await readFile(entry, 'utf8')).toBe('say:未知写入 -clear;')
})

it('整组回答的完成记录与当前输入不匹配时停止恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-workflow-answer-digest-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  const entry = join(workspaceRoot, 'game/scene/start.txt')
  await mkdir(join(workspaceRoot, 'game/scene'), { recursive: true })
  await writeFile(entry, 'say:已有候选 -clear;')
  const candidateSnapshotId = 'e'.repeat(40)
  const execution = answeredExecutionOf(workspaceRoot, candidateSnapshotId)
  const tag = createHash('sha256').update('reply-answers').digest('hex').slice(0, 16)
  await writeDurableEffect(join(root, 'state'), execution, {
    operationId: execution.operationId,
    stepId: `generate-0-${tag}`,
    // 账本来自另一组回答输入，不能冒充当前执行记录。
    inputDigest: candidateInputDigest('generate', { ...execution, replies: [] }),
    status: 'completed',
    kind: 'fileWrite',
    candidateRevision: candidateSnapshotId,
    resultDigest: candidateSnapshotId
  })
  let agentCalls = 0
  const workflow = new PiSceneGenerationWorkflow({
    artifacts: {
      async readCandidate() {
        throw new Error('输入不匹配时不应读取候选')
      },
      async saveCandidateRevision() {
        throw new Error('输入不匹配时不应保存候选')
      }
    },
    versions: {} as never,
    domain: {} as SceneGenerationDomainService,
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
    stateRoot: join(root, 'state'),
    createAgent: async () => {
      agentCalls += 1
      throw new Error('输入不匹配时不应创建模型')
    },
    nextId: () => 'next-id',
    now: () => 1
  })
  await expect(workflow.continueInteraction(runtimeOf(execution, [], []))).rejects.toThrow('不匹配')
  expect(agentCalls).toBe(0)
  expect(await readFile(entry, 'utf8')).toBe('say:已有候选 -clear;')
})

it('其他操作的完成记录不能冒充本次整组回答写入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-workflow-answer-other-op-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  await mkdir(join(workspaceRoot, 'game/scene'), { recursive: true })
  await writeFile(join(workspaceRoot, 'game/scene/start.txt'), 'say:其他操作 -clear;')
  const candidateSnapshotId = 'f'.repeat(40)
  const execution = answeredExecutionOf(workspaceRoot, candidateSnapshotId)
  const other = { ...execution, operationId: 'other-operation' }
  const tag = createHash('sha256').update('reply-answers').digest('hex').slice(0, 16)
  await writeDurableEffect(join(root, 'state'), other, {
    operationId: other.operationId,
    stepId: `generate-0-${tag}`,
    inputDigest: candidateInputDigest('generate', {
      ...other,
      candidateSnapshotId: undefined
    }),
    status: 'completed',
    kind: 'fileWrite',
    candidateRevision: candidateSnapshotId,
    resultDigest: candidateSnapshotId
  })
  let agentCalls = 0
  const workflow = new PiSceneGenerationWorkflow({
    artifacts: {
      async readCandidate() {
        throw new Error('其他操作记录不应读取当前候选')
      },
      async saveCandidateRevision() {
        throw new Error('其他操作记录不应保存候选')
      }
    },
    versions: {} as never,
    domain: {} as SceneGenerationDomainService,
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
    stateRoot: join(root, 'state'),
    createAgent: async () => {
      agentCalls += 1
      throw new Error('其他操作记录不应创建模型')
    },
    nextId: () => 'next-id',
    now: () => 1
  })
  await expect(workflow.continueInteraction(runtimeOf(execution, [], []))).rejects.toThrow(
    '候选已存在，旧题组已失效'
  )
  expect(agentCalls).toBe(0)
})

it('整组回答完成记录的候选修订不是当前候选时停止恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-workflow-answer-revision-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  await mkdir(join(workspaceRoot, 'game/scene'), { recursive: true })
  await writeFile(join(workspaceRoot, 'game/scene/start.txt'), 'say:候选修订 -clear;')
  const candidateSnapshotId = '1'.repeat(40)
  const writtenSnapshotId = '2'.repeat(40)
  const execution = answeredExecutionOf(workspaceRoot, candidateSnapshotId)
  const tag = createHash('sha256').update('reply-answers').digest('hex').slice(0, 16)
  await writeDurableEffect(join(root, 'state'), execution, {
    operationId: execution.operationId,
    stepId: `generate-0-${tag}`,
    inputDigest: candidateInputDigest('generate', {
      ...execution,
      candidateSnapshotId: undefined
    }),
    status: 'completed',
    kind: 'fileWrite',
    candidateRevision: writtenSnapshotId,
    resultDigest: writtenSnapshotId
  })
  let agentCalls = 0
  const workflow = new PiSceneGenerationWorkflow({
    artifacts: {
      async readCandidate() {
        throw new Error('候选不一致时不应读取候选')
      },
      async saveCandidateRevision() {
        throw new Error('候选不一致时不应保存候选')
      }
    },
    versions: {} as never,
    domain: {} as SceneGenerationDomainService,
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
    stateRoot: join(root, 'state'),
    createAgent: async () => {
      agentCalls += 1
      throw new Error('候选不一致时不应创建模型')
    },
    nextId: () => 'next-id',
    now: () => 1
  })
  await expect(workflow.continueInteraction(runtimeOf(execution, [], []))).rejects.toThrow(
    '候选修订与本次写入不一致'
  )
  expect(agentCalls).toBe(0)
})

it('已有候选时旧整组回答被拒绝，不能覆盖当前候选', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-workflow-answer-conflict-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  await mkdir(join(workspaceRoot, 'game/scene'), { recursive: true })
  const candidateSnapshotId = 'b'.repeat(40)
  const checkpointId = piReviewCheckpointId('operation', candidateSnapshotId)
  const interaction = {
    interactionId: 'interaction-stale-question',
    checkpointId,
    kind: 'decision' as const,
    message: '本轮需要你先确认 1 个创作决定，确认后会继续生成。',
    options: [],
    questions: [
      {
        questionId: 'q1',
        prompt: '开场停在哪里？',
        options: [
          { id: 'q1o1', label: '门外', description: '保留悬念' },
          { id: 'q1o2', label: '桌边', description: '收在日常' },
          { id: 'q1o3', label: '雨里', description: '强调离别' }
        ]
      }
    ],
    allowedReplies: ['answers', 'discard'] as const
  }
  const answerReply = {
    projectId: 'project',
    sceneId: 'scene',
    operationId: 'operation',
    threadId: 'thread',
    branchId: 'branch',
    interactionId: interaction.interactionId,
    checkpointId,
    replyId: 'reply-stale-answers',
    reply: {
      kind: 'answers' as const,
      answers: [{ questionId: 'q1', optionId: 'q1o1' }]
    },
    selections: [
      {
        questionId: 'q1',
        prompt: '开场停在哪里？',
        optionId: 'q1o1',
        label: '门外',
        description: '保留悬念'
      }
    ]
  }
  const execution: SceneGenerationExecution = {
    ...executionOf(workspaceRoot),
    state: 'pending',
    checkpointId,
    candidateSnapshotId,
    interaction,
    replies: [answerReply],
    pendingReply: answerReply
  }
  const workflow = new PiSceneGenerationWorkflow({
    artifacts: {} as Pick<SceneArtifactGateway, 'readCandidate' | 'saveCandidateRevision'>,
    versions: {} as never,
    domain: {} as SceneGenerationDomainService,
    prompts: {} as FilePromptLoader,
    skills: {} as FileSkillLoader,
    stateRoot: join(root, 'state'),
    createAgent: async () => {
      throw new Error('旧题组回答不能在已有候选上创建模型')
    },
    nextId: () => 'next-id'
  })
  await expect(workflow.continueInteraction(runtimeOf(execution, [], []))).rejects.toThrow(
    '候选已存在，旧题组已失效'
  )
})

it('同一草稿和同一诊断签名再次出现时停止自动修正，等待人工', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-workflow-stalled-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  const entry = join(workspaceRoot, 'game/scene/start.txt')
  await mkdir(join(workspaceRoot, 'game/scene'), { recursive: true })
  await writeFile(entry, 'say:种子 -clear;')
  const execution = { ...executionOf(workspaceRoot), policy: { maxCorrections: 3 } }
  const progress: SceneGenerationWorkflowProgress[] = []
  const revisions: string[] = []
  let runs = 0
  const agent = {
    async run(request: PiAgentRunRequest): Promise<PiAgentRunResult> {
      runs += 1
      const write = request.tools.find((tool) => tool.name === 'writeCandidate')
      if (!write) throw new Error('缺少写工具')
      const revision = /"revision"\s*:\s*"([^"]+)"/.exec(String(request.prompt))?.[1]
      await write.execute(
        'call-write',
        {
          path: 'game/scene/start.txt',
          expectedRevision: revision,
          content: 'changeBg:missing.svg;\nsay:同一诊断 -clear;\nend;'
        },
        request.signal
      )
      return succeededRun()
    }
  } as unknown as PiAgentExecutor
  const snapshotId = 'a'.repeat(40)
  const workflow = new PiSceneGenerationWorkflow({
    artifacts: {
      async readCandidate() {
        return candidateOf(snapshotId, [missingAssetIssue(1)])
      },
      async saveCandidateRevision() {
        return { candidateSnapshotId: snapshotId }
      }
    },
    versions: {
      async inspectBaseline() {
        return { baselineState: 'unchanged' as const, lockState: 'unlocked' as const }
      }
    },
    domain: new SceneGenerationDomainServiceImpl(),
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
    stateRoot: join(root, 'state'),
    createAgent: async () => agent,
    nextId: () => 'next-id',
    now: () => 1
  })

  const outcome = await workflow.executeGeneration(runtimeOf(execution, progress, revisions))
  expect(runs).toBe(2)
  expect(outcome.state).toBe('waiting')
  if (outcome.state !== 'waiting') throw new Error('应等待人工修正')
  expect(outcome.interaction.kind).toBe('correction')
  expect(outcome.interaction.allowedReplies).toEqual(['revise', 'discard'])
  expect(outcome.interaction.message).toContain('同一草稿和诊断没有变化')
  expect(outcome.interaction.message).not.toContain('accept')
  expect(revisions).toEqual([snapshotId, snapshotId])
})

it('自动修正达到上限后等待人工，allowedReplies 不含接受', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-workflow-correction-limit-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  const entry = join(workspaceRoot, 'game/scene/start.txt')
  await mkdir(join(workspaceRoot, 'game/scene'), { recursive: true })
  await writeFile(entry, 'say:种子 -clear;')
  const execution = executionOf(workspaceRoot)
  const progress: SceneGenerationWorkflowProgress[] = []
  const revisions: string[] = []
  const issueSets: SceneValidationReport['issues'][] = [
    [missingAssetIssue(2)],
    [missingAssetIssue(3)]
  ]
  const issuesByRevision = new Map<string, SceneValidationReport['issues']>()
  let runs = 0
  const agent = {
    async run(request: PiAgentRunRequest): Promise<PiAgentRunResult> {
      runs += 1
      const write = request.tools.find((tool) => tool.name === 'writeCandidate')
      if (!write) throw new Error('缺少写工具')
      const revision = /"revision"\s*:\s*"([^"]+)"/.exec(String(request.prompt))?.[1]
      await write.execute(
        'call-write',
        {
          path: 'game/scene/start.txt',
          expectedRevision: revision,
          content: `changeBg:missing-${runs}.svg;\nsay:第 ${runs} 轮 -clear;\nend;`
        },
        request.signal
      )
      return succeededRun()
    }
  } as unknown as PiAgentExecutor
  let saved = 0
  const workflow = new PiSceneGenerationWorkflow({
    artifacts: {
      async readCandidate(_execution, id) {
        return candidateOf(id, issuesByRevision.get(id) ?? [])
      },
      async saveCandidateRevision() {
        const candidateSnapshotId = `${String(saved + 1).padStart(40, 'a')}`
        issuesByRevision.set(candidateSnapshotId, issueSets[saved] ?? [])
        saved += 1
        return { candidateSnapshotId }
      }
    },
    versions: {
      async inspectBaseline() {
        return { baselineState: 'unchanged' as const, lockState: 'unlocked' as const }
      }
    },
    domain: new SceneGenerationDomainServiceImpl(),
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
    stateRoot: join(root, 'state'),
    createAgent: async () => agent,
    nextId: () => 'next-id',
    now: () => 1
  })

  const outcome = await workflow.executeGeneration(runtimeOf(execution, progress, revisions))
  expect(runs).toBe(2)
  expect(outcome.state).toBe('waiting')
  if (outcome.state !== 'waiting') throw new Error('应等待人工修正')
  expect(outcome.interaction.kind).toBe('correction')
  expect(outcome.interaction.allowedReplies).toEqual(['revise', 'discard'])
  expect(outcome.interaction.message).toContain('已自动修正 1 次')
  expect(outcome.interaction.message).not.toContain('accept')
})

it('连续对白缺少上下文时立即等待作者说明，不自动改写', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-workflow-context-only-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  const entry = join(workspaceRoot, 'game/scene/start.txt')
  await mkdir(join(workspaceRoot, 'game/scene'), { recursive: true })
  await writeFile(entry, 'say:种子 -clear;')
  const execution = executionOf(workspaceRoot)
  const progress: SceneGenerationWorkflowProgress[] = []
  const revisions: string[] = []
  let runs = 0
  const agent = {
    async run(request: PiAgentRunRequest): Promise<PiAgentRunResult> {
      runs += 1
      const write = request.tools.find((tool) => tool.name === 'writeCandidate')
      if (!write) throw new Error('缺少写工具')
      const revision = /"revision"\s*:\s*"([^"]+)"/.exec(String(request.prompt))?.[1]
      await write.execute(
        'call-write',
        {
          path: 'game/scene/start.txt',
          expectedRevision: revision,
          content: '林:她看向站台。;\nend;'
        },
        request.signal
      )
      return succeededRun()
    }
  } as unknown as PiAgentExecutor
  const snapshotId = 'b'.repeat(40)
  const workflow = new PiSceneGenerationWorkflow({
    artifacts: {
      async readCandidate() {
        return candidateOf(snapshotId, [
          {
            code: 'missing-background',
            message: '连续对白缺少背景',
            correctable: true,
            requiresHumanDecision: false
          },
          {
            code: 'missing-character',
            message: '连续对白缺少角色',
            correctable: true,
            requiresHumanDecision: false
          }
        ])
      },
      async saveCandidateRevision() {
        return { candidateSnapshotId: snapshotId }
      }
    },
    versions: {
      async inspectBaseline() {
        return { baselineState: 'unchanged' as const, lockState: 'unlocked' as const }
      }
    },
    domain: new SceneGenerationDomainServiceImpl(),
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
    stateRoot: join(root, 'state'),
    createAgent: async () => agent,
    nextId: () => 'next-id',
    now: () => 1
  })

  const outcome = await workflow.executeGeneration(runtimeOf(execution, progress, revisions))
  expect(runs).toBe(1)
  expect(outcome.state).toBe('waiting')
  if (outcome.state !== 'waiting') throw new Error('应等待作者补充上下文')
  expect(outcome.interaction.kind).toBe('correction')
  expect(outcome.interaction.allowedReplies).toEqual(['revise', 'discard'])
  expect(outcome.interaction.message).toContain('缺少背景或角色上下文，需要作者说明。')
})

it('同一说明出现在另一条语句仍算进展，不判停滞', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-workflow-progress-signature-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  const entry = join(workspaceRoot, 'game/scene/start.txt')
  await mkdir(join(workspaceRoot, 'game/scene'), { recursive: true })
  await writeFile(entry, 'say:种子 -clear;')
  const execution = { ...executionOf(workspaceRoot), policy: { maxCorrections: 2 } }
  const progress: SceneGenerationWorkflowProgress[] = []
  const revisions: string[] = []
  const issueSets: SceneValidationReport['issues'][] = [
    [missingAssetIssue(2)],
    [missingAssetIssue(3)],
    []
  ]
  const issuesByRevision = new Map<string, SceneValidationReport['issues']>()
  let runs = 0
  const agent = {
    async run(request: PiAgentRunRequest): Promise<PiAgentRunResult> {
      runs += 1
      const write = request.tools.find((tool) => tool.name === 'writeCandidate')
      if (!write) throw new Error('缺少写工具')
      const revision = /"revision"\s*:\s*"([^"]+)"/.exec(String(request.prompt))?.[1]
      await write.execute(
        'call-write',
        {
          path: 'game/scene/start.txt',
          expectedRevision: revision,
          content: `changeBg:missing.svg;\nsay:第 ${runs} 行 -clear;\nend;`
        },
        request.signal
      )
      return succeededRun()
    }
  } as unknown as PiAgentExecutor
  let saved = 0
  const workflow = new PiSceneGenerationWorkflow({
    artifacts: {
      async readCandidate(_execution, id) {
        return candidateOf(id, issuesByRevision.get(id) ?? [])
      },
      async saveCandidateRevision() {
        const candidateSnapshotId = `${String(saved + 1).padStart(40, 'b')}`
        issuesByRevision.set(candidateSnapshotId, issueSets[saved] ?? [])
        saved += 1
        return { candidateSnapshotId }
      }
    },
    versions: {
      async inspectBaseline() {
        return { baselineState: 'unchanged' as const, lockState: 'unlocked' as const }
      }
    },
    domain: new SceneGenerationDomainServiceImpl(),
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
    stateRoot: join(root, 'state'),
    createAgent: async () => agent,
    nextId: () => 'next-id',
    now: () => 1
  })

  const outcome = await workflow.executeGeneration(runtimeOf(execution, progress, revisions))
  expect(runs).toBe(3)
  expect(outcome.state).toBe('waiting')
  if (outcome.state !== 'waiting') throw new Error('应进入审阅等待')
  expect(outcome.interaction.kind).toBe('review')
  expect(outcome.interaction.message).not.toContain('同一草稿和诊断没有变化')
  expect(revisions).toHaveLength(3)
})

it('历史读取把写前题组按执行记录原样呈现，不冒充已发布候选', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-workflow-question-history-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  await mkdir(join(workspaceRoot, 'game/scene'), { recursive: true })
  const stateRoot = join(root, 'ai')
  const checkpointId = piReviewCheckpointId('operation')
  const execution: SceneGenerationExecution = {
    ...executionOf(workspaceRoot),
    state: 'waiting',
    step: undefined,
    checkpointId,
    interaction: {
      interactionId: 'interaction-question',
      checkpointId,
      kind: 'decision',
      message: '本轮需要你先确认 1 个创作决定，确认后会继续生成。',
      options: [],
      questions: [
        {
          questionId: 'q1',
          prompt: '开场停在哪里？',
          detail: '影响第一个画面',
          options: [
            { id: 'q1o1', label: '门外', description: '保留悬念' },
            { id: 'q1o2', label: '桌边', description: '收在日常' },
            { id: 'q1o3', label: '雨里', description: '强调离别' }
          ]
        }
      ],
      allowedReplies: ['answers', 'discard']
    }
  }
  const executions = new FileSceneGenerationExecutionRepositoryImpl(root)
  await executions.createExecution(execution)
  const reader = new WebGalSceneGenerationHistoryReaderImpl(
    stateRoot,
    new ReadOnlyGenerationCheckpointStore(stateRoot),
    new AiProjectFileSystemImpl(root),
    executions
  )
  const scope = {
    projectId: 'project',
    sceneId: 'scene',
    threadId: 'thread',
    branchId: 'branch'
  }
  const checkpoint = await reader.readCheckpoint({ ...scope, checkpointId })
  expect(checkpoint.candidateSnapshotId).toBeUndefined()
  expect(checkpoint.view).toMatchObject({
    checkpointId,
    summary: '等待回答创作问题，回答后继续生成',
    canView: true,
    canContinue: false,
    canReply: true,
    phase: 'waiting'
  })
  expect(checkpoint.execution.interaction?.kind).toBe('decision')
  expect(checkpoint.execution.interaction?.questions?.[0]).toMatchObject({
    questionId: 'q1',
    prompt: '开场停在哪里？',
    detail: '影响第一个画面',
    options: [{ id: 'q1o1' }, { id: 'q1o2' }, { id: 'q1o3' }]
  })
})

function succeededRun(): PiAgentRunResult {
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

function missingAssetIssue(line?: number): SceneValidationReport['issues'][number] {
  return {
    code: 'missing-asset',
    message: '候选引用的素材不存在',
    correctable: true,
    requiresHumanDecision: false,
    ...(line === undefined ? {} : { line })
  }
}

function candidateOf(
  candidateSnapshotId: string,
  issues: SceneValidationReport['issues']
): SceneGenerationCandidate {
  return {
    candidateSnapshotId,
    artifact: {
      scene: { projectId: 'project', sceneId: 'scene' },
      hasEntry: true,
      statements: []
    },
    preview: {
      entryFile: 'game/scene/start.txt',
      files: [],
      parserVersion: 'test',
      commandLocations: [],
      assetLocations: [],
      validationReport: {
        issues: issues.map((issue) => ({
          ...issue,
          code: issue.code as SceneValidationIssueCode
        }))
      }
    },
    assetChanges: []
  }
}

/** 写前题组已由应用持久接受整组回答，工作流应从同一回复续跑。 */
function answeredExecutionOf(
  workspaceRoot: string,
  candidateSnapshotId: string | undefined
): SceneGenerationExecution {
  const reply: ReplySceneGenerationInteractionDTO = {
    projectId: 'project',
    sceneId: 'scene',
    operationId: 'operation',
    threadId: 'thread',
    branchId: 'branch',
    interactionId: 'interaction-answers',
    checkpointId: piReviewCheckpointId('operation'),
    replyId: 'reply-answers',
    reply: {
      kind: 'answers',
      answers: [
        { questionId: 'q1', optionId: 'q1o1' },
        { questionId: 'q2', optionId: 'q2o2' }
      ]
    },
    selections: [
      {
        questionId: 'q1',
        prompt: '第一个问题',
        optionId: 'q1o1',
        label: '选项一',
        description: '说明一',
        body: '保留这个方向'
      },
      {
        questionId: 'q2',
        prompt: '第二个问题',
        optionId: 'q2o2',
        label: '选项二',
        description: '说明二'
      }
    ]
  }
  return {
    ...executionOf(workspaceRoot),
    state: 'running',
    ...(candidateSnapshotId === undefined ? {} : { candidateSnapshotId }),
    replies: [reply],
    pendingReply: reply
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
    policy: { maxCorrections: 1 },
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

function runtimeOf(
  execution: SceneGenerationExecution,
  progress: SceneGenerationWorkflowProgress[],
  revisions: string[],
  controller = new AbortController()
): SceneGenerationRuntime {
  return {
    execution,
    signal: controller.signal,
    userAbortSignal: controller.signal,
    activeTimeoutSignal: AbortSignal.any([]),
    async publishProgress(event) {
      progress.push(event)
      return execution
    },
    async recordCandidateRevision(revision) {
      revisions.push(revision.candidateSnapshotId)
      return execution
    },
    async recordFailure() {
      return execution
    }
  }
}
