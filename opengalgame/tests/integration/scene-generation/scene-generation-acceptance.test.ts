import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Page } from '@playwright/test'
import SceneParser, { ADD_NEXT_ARG_LIST, SCRIPT_CONFIG } from 'webgal-parser'
import { expect, it, vi } from 'vitest'
import type { ConnectionSettingsInfo } from '@domain/connections/models/ConnectionSettings'
import { createSceneGeneration, type SceneGenerationServices } from '@bootstrap/sceneGeneration'
import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import type { SceneGenerationStatusVO } from '@application/scene-generation/vo/SceneGenerationVO'
import { WebgalRuntimeHostImpl } from '@infrastructure/webgal/runtime/WebgalRuntimeHostImpl'
import {
  generationFixture,
  request,
  type GenerationFixture
} from '../../../../harness/acceptance/support/generationFixture'
import { FileSceneGenerationExecutionRepositoryImpl } from '@infrastructure/scene-generation/execution/FileSceneGenerationExecutionRepositoryImpl'

const root = process.env.OPENGALGAME_SCENE_ACCEPTANCE_DIR

type P1CaptureResult = {
  text: string
  termination: 'eof' | 'aborted' | 'consumer-cancel' | 'error'
  sawDone: boolean
  payloadCount: number
  parseErrorCount: number
  errorName: string | null
}
type P1Captured = {
  tools: readonly string[]
  capture: Promise<P1CaptureResult>
  http: { status: number; ok: boolean; contentType: string | null }
}
interface P1SafeContext {
  finalState: string | null
  initialInteractionKind: string | null
  candidateSnapshotId: string | null
  commitId: string | null
  validationCount: number | null
  failureClass: string | null
  failureReason: string | null
  failureCode: number | null
  httpStatus: number | null
  sdkException: Record<string, unknown> | null
  degradedNoticeSeen: boolean
  reviseCount: number
}

vi.setConfig({ testTimeout: 0 })

it.runIf(process.env.OPENGALGAME_RUN_EXISTING_SCENE_ENGINE === '1')(
  '在已生成的替身和真实模型成品上补验引擎，不重复模型调用',
  async () => {
    if (!root) throw new Error('缺少已有成品目录')
    const acceptedRealDirectory =
      existsSync(join(resolve(root), 'p1-real', 'state')) ? 'p1-real' : 'real'
    for (const mode of ['stub', acceptedRealDirectory]) {
      const artifactRoot = join(resolve(root), mode)
      const execution = (await new FileSceneGenerationExecutionRepositoryImpl(
        join(artifactRoot, 'state')
      ).readExecution(request))!
      expect(execution.state).toBe('succeeded')
      const engine = await engineSmoke(
        execution.source.projectRoot,
        artifactRoot,
        execution.result!.preview.files
      )
      await writeFile(
        join(artifactRoot, 'acceptance-report.json'),
        JSON.stringify(
          {
            modelMode: mode === 'stub' ? 'stub' : 'real',
            artifactMode: mode,
            projectRoot: execution.source.projectRoot,
            inputs: execution.inputSnapshot,
            entryFile: join(execution.source.projectRoot, 'game/scene/start.txt'),
            candidateSnapshotId: execution.candidateSnapshotId,
            commitId: execution.result!.commitId,
            preview: execution.result!.preview,
            budget: execution.budget,
            engineSmoke: engine
          },
          null,
          2
        ) + '\n'
      )
    }
  }
)

it.runIf(process.env.OPENGALGAME_RUN_SCENE_ACCEPTANCE === '1')(
  '保留替身模型验收工程、修订、提交和真实引擎烟测证据',
  async () => {
    await acceptance('stub')
  }
)

it.runIf(process.env.OPENGALGAME_RUN_REAL_MODEL === '1')(
  '真实模型通过文件工具生成可提交的真实成品',
  async () => {
    await acceptance('real')
  }
)

it.runIf(process.env.OPENGALGAME_RUN_REAL_MODEL === '1')(
  '真实模型在同画布完成候选并按终态动作提交',
  async () => {
    const f = await generationFixture({
      keep: root ? join(resolve(root), 'p1-real') : undefined
    })
    const captured: P1Captured[] = []
    const safeContext: P1SafeContext = {
      finalState: null,
      initialInteractionKind: null,
      candidateSnapshotId: null,
      commitId: null,
      validationCount: null,
      failureClass: null,
      failureReason: null,
      failureCode: null,
      httpStatus: null,
      sdkException: null,
      degradedNoticeSeen: false,
      reviseCount: 0
    }
    let app: SceneGenerationServices | undefined
    let sdkException: unknown
    try {
      const capturingFetch: typeof fetch = async (input, init) => {
        const tools = toolNamesOf(init?.body)
        const response = await fetch(input, init)
        const http = {
          status: response.status,
          ok: response.ok,
          contentType: response.headers.get('content-type')
        }
        if (!response.body) {
          captured.push({
            tools,
            http,
            capture: Promise.resolve({
              text: '',
              termination: 'eof',
              sawDone: false,
              payloadCount: 0,
              parseErrorCount: 0,
              errorName: null
            })
          })
          return response
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let text = ''
        let settled = false
        const { promise: capture, resolve: resolveCapture } =
          Promise.withResolvers<P1CaptureResult>()
        const finish = (
          termination: P1CaptureResult['termination'],
          error?: unknown
        ): void => {
          if (settled) return
          settled = true
          text += decoder.decode()
          const counts = inspectResponseCounts(text)
          resolveCapture({
            text,
            termination,
            sawDone: text.includes('[DONE]'),
            payloadCount: counts.payloadCount,
            parseErrorCount: counts.parseErrorCount,
            errorName: error instanceof Error ? error.name : null
          })
        }
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const { done, value } = await reader.read()
              if (settled) return
              if (done) {
                finish('eof')
                controller.close()
                return
              }
              text += decoder.decode(value, { stream: true })
              controller.enqueue(value)
            } catch (error) {
              if (settled) return
              finish(init?.signal?.aborted ? 'aborted' : 'error', error)
              controller.error(error)
            }
          },
          cancel(reason) {
            finish(init?.signal?.aborted ? 'aborted' : 'consumer-cancel')
            void reader.cancel(reason).catch(() => undefined)
          }
        })
        captured.push({ tools, http, capture })
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        })
      }
      const appInstance = await createSceneGeneration({
        ...f.config,
        loadSettings: p1AcceptanceSettings,
        fetcher: capturingFetch
      })
      app = appInstance
      await appInstance.generation.generateScene({
        ...request,
        reviewCandidate: true,
        policy: { maxCorrections: 2 }
      })
      await f.run()

      const status = await appInstance.status.getSceneGenerationStatus(request)
      const execution = (await appInstance.ports.executions.readExecution(request))!
      safeContext.finalState = status.state
      safeContext.initialInteractionKind = status.interaction?.kind ?? null
      if (status.interaction?.message.includes('完成摘要未生成'))
        safeContext.degradedNoticeSeen = true
      safeContext.candidateSnapshotId =
        status.candidateSnapshotId ?? execution.candidateSnapshotId ?? null
      safeContext.validationCount = status.result?.preview.validationReport.issues.length ?? null
      expect(['waiting', 'succeeded']).toContain(status.state)
      if (status.state === 'waiting') {
        expect(['review', 'correction']).toContain(status.interaction?.kind)
        expect(status.candidateSnapshotId).toBeTruthy()
      } else expect(status.result?.commitId).toBeTruthy()

      let currentStatus = status
      let currentExecution = execution
      let revised = 0
      while (
        currentStatus.state === 'waiting' &&
        currentStatus.interaction?.kind === 'correction' &&
        revised < 2
      ) {
        const interaction = currentStatus.interaction
        const receipt = await appInstance.generation.replySceneGenerationInteraction({
          projectId: currentStatus.projectId,
          sceneId: currentStatus.sceneId,
          operationId: currentStatus.operationId,
          threadId: currentStatus.threadId,
          branchId: currentStatus.branchId,
          interactionId: interaction.interactionId,
          checkpointId: interaction.checkpointId,
          candidateSnapshotId: interaction.candidateSnapshotId,
          replyId: `p1-revise-${revised + 1}`,
          reply: { kind: 'revise', body: '请按当前校验提示修正可修正项，保留现有剧情。' }
        })
        expect(receipt.accepted).toBe(true)
        await f.run()
        currentStatus = await appInstance.status.getSceneGenerationStatus(request)
        currentExecution = (await appInstance.ports.executions.readExecution(request))!
        revised += 1
        safeContext.reviseCount = revised
        if (currentStatus.interaction?.message.includes('完成摘要未生成'))
          safeContext.degradedNoticeSeen = true
        safeContext.finalState = currentStatus.state
        safeContext.candidateSnapshotId =
          currentStatus.candidateSnapshotId ?? currentExecution.candidateSnapshotId ?? null
        const revisedCandidateId =
          currentStatus.candidateSnapshotId ?? currentExecution.candidateSnapshotId
        expect(revisedCandidateId).toBeTruthy()
        const revisedCandidate = await appInstance.ports.artifacts.readCandidate(
          currentExecution,
          revisedCandidateId!
        )
        expect(revisedCandidate.candidateSnapshotId).toBe(revisedCandidateId)
      }
      while (
        currentStatus.state === 'waiting' &&
        currentStatus.interaction?.kind === 'review' &&
        currentStatus.interaction.message.includes('完成摘要未生成') &&
        revised < 2
      ) {
        const interaction = currentStatus.interaction
        const receipt = await appInstance.generation.replySceneGenerationInteraction({
          projectId: currentStatus.projectId,
          sceneId: currentStatus.sceneId,
          operationId: currentStatus.operationId,
          threadId: currentStatus.threadId,
          branchId: currentStatus.branchId,
          interactionId: interaction.interactionId,
          checkpointId: interaction.checkpointId,
          candidateSnapshotId: interaction.candidateSnapshotId,
          replyId: `p1-revise-${revised + 1}`,
          reply: { kind: 'revise', body: '请补充本次创作取舍摘要，保留现有剧情后重新提交候选。' }
        })
        expect(receipt.accepted).toBe(true)
        await f.run()
        currentStatus = await appInstance.status.getSceneGenerationStatus(request)
        currentExecution = (await appInstance.ports.executions.readExecution(request))!
        revised += 1
        safeContext.reviseCount = revised
        if (currentStatus.interaction?.message.includes('完成摘要未生成'))
          safeContext.degradedNoticeSeen = true
        safeContext.finalState = currentStatus.state
        safeContext.candidateSnapshotId =
          currentStatus.candidateSnapshotId ?? currentExecution.candidateSnapshotId ?? null
        const revisedCandidateId =
          currentStatus.candidateSnapshotId ?? currentExecution.candidateSnapshotId
        expect(revisedCandidateId).toBeTruthy()
        const revisedCandidate = await appInstance.ports.artifacts.readCandidate(
          currentExecution,
          revisedCandidateId!
        )
        expect(revisedCandidate.candidateSnapshotId).toBe(revisedCandidateId)
      }
      if (
        currentStatus.state === 'waiting' &&
        currentStatus.interaction?.kind === 'review' &&
        currentStatus.interaction.message.includes('完成摘要未生成')
      )
        throw new Error('候选完成摘要仍未生成，验收未通过（模型内容/摘要未达标）')
      expect(['waiting', 'succeeded']).toContain(currentStatus.state)
      safeContext.finalState = currentStatus.state
      if (currentStatus.state === 'waiting') {
        expect(currentStatus.interaction?.kind).toBe('review')
      } else {
        expect(currentStatus.result?.commitId).toBeTruthy()
        expect(currentStatus.result?.preview.validationReport.issues).toEqual([])
      }
      const candidateSnapshotId =
        currentStatus.candidateSnapshotId ?? currentExecution.candidateSnapshotId
      expect(candidateSnapshotId).toBeTruthy()
      safeContext.candidateSnapshotId = candidateSnapshotId ?? null
      const candidate = await appInstance.ports.artifacts.readCandidate(
        currentExecution,
        candidateSnapshotId!
      )
      expect(candidate.candidateSnapshotId).toBe(candidateSnapshotId)

      const captures = await Promise.all(captured.map((item) => item.capture))
      const captureComplete =
        captures.length === captured.length &&
        captures.every((item) => item.sawDone || item.termination === 'eof')
      if (!captureComplete)
        throw new Error('模型动作取证不完整：SSE 捕获未正常完成，不能据此判断模型未发动作')
      expect(captured.length).toBeGreaterThan(0)
      const responses = captures.map((item) => item.text)
      const requestToolSets = captured
        .map((item) => item.tools)
        .filter((tools) => tools.length > 0)
      expect(requestToolSets.length).toBeGreaterThan(0)
      expect(requestToolSets.every((tools) => !tools.includes('read_file'))).toBe(true)
      const observedActions = [...new Set(responses.flatMap(responseActions))]
      expect(observedActions.some(isTerminalAction)).toBe(true)

      let finalStatus = currentStatus
      let finalExecution = currentExecution
      if (currentStatus.state === 'waiting') {
        const interaction = currentStatus.interaction!
        const receipt = await appInstance.generation.replySceneGenerationInteraction({
          projectId: currentStatus.projectId,
          sceneId: currentStatus.sceneId,
          operationId: currentStatus.operationId,
          threadId: currentStatus.threadId,
          branchId: currentStatus.branchId,
          interactionId: interaction.interactionId,
          checkpointId: interaction.checkpointId,
          candidateSnapshotId: interaction.candidateSnapshotId,
          replyId: 'p1-accept-1',
          reply: { kind: 'accept' }
        })
        expect(receipt.accepted).toBe(true)
        await f.run()
        finalStatus = await appInstance.status.getSceneGenerationStatus(request)
        expect(finalStatus.state).toBe('succeeded')
        expect(finalStatus.result?.commitId).toBeTruthy()
        expect(finalStatus.result?.preview.validationReport.issues).toEqual([])
        finalExecution = (await appInstance.ports.executions.readExecution(request))!
      }
      safeContext.finalState = finalStatus.state
      safeContext.commitId = finalStatus.result?.commitId ?? null
      safeContext.validationCount =
        finalStatus.result?.preview.validationReport.issues.length ??
        finalExecution.artifactValidation?.issues.length ??
        safeContext.validationCount
      const failure = finalExecution.failure
      safeContext.failureClass =
        failure && 'failureClass' in failure ? (failure.failureClass ?? null) : null
      safeContext.failureReason = failure?.reason ?? null
      safeContext.failureCode = failure?.code ?? null
      safeContext.httpStatus =
        failure && 'httpStatus' in failure ? (failure.httpStatus ?? null) : null
    } catch (error) {
      sdkException = error
      throw error
    } finally {
      safeContext.sdkException = safeExceptionFields(sdkException)
      await writeP1SafeReport({ f, app, captured, context: safeContext })
    }
  }
)

function toolNamesOf(body: unknown): readonly string[] {
  if (typeof body !== 'string') throw new Error('模型请求体不是字符串，无法核对工具集')
  let parsed: { tools?: unknown }
  try {
    parsed = JSON.parse(body) as { tools?: unknown }
  } catch (error) {
    throw new Error('模型请求体不是有效 JSON，无法核对工具集', { cause: error })
  }
  if (parsed.tools === undefined) return []
  if (!Array.isArray(parsed.tools)) throw new Error('模型请求体的 tools 不是数组，无法核对工具集')
  return parsed.tools.map((tool: unknown) => {
    const entry = tool as { name?: unknown; function?: { name?: unknown } } | null
    const name = entry?.function?.name ?? entry?.name
    if (typeof name !== 'string' || name.length === 0)
      throw new Error('模型请求体的工具项缺少名称，无法核对工具集')
    return name
  })
}

const TERMINAL_ACTIONS = ['submit_scene_result', 'report_blocked'] as const

function isTerminalAction(action: string): action is (typeof TERMINAL_ACTIONS)[number] {
  return (TERMINAL_ACTIONS as readonly string[]).includes(action)
}

function inspectResponseCounts(text: string): {
  payloadCount: number
  parseErrorCount: number
} {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { payloadCount: 0, parseErrorCount: 0 }
  if (trimmed.startsWith('{')) {
    try {
      JSON.parse(trimmed)
      return { payloadCount: 1, parseErrorCount: 0 }
    } catch {
      return { payloadCount: 0, parseErrorCount: 1 }
    }
  }
  let payloadCount = 0
  let parseErrorCount = 0
  for (const line of trimmed.split(/\r?\n/u)) {
    const match = /^data:\s*(.+)$/u.exec(line)
    if (!match || match[1].trim() === '[DONE]') continue
    try {
      JSON.parse(match[1])
      payloadCount += 1
    } catch {
      parseErrorCount += 1
    }
  }
  return { payloadCount, parseErrorCount }
}

function responseActions(text: string): readonly string[] {
  const names = new Set<string>()
  const contents: string[] = []
  for (const payload of responsePayloads(text)) {
    for (const choice of payload.choices ?? []) {
      for (const call of [
        ...(choice.message?.tool_calls ?? []),
        ...(choice.delta?.tool_calls ?? [])
      ])
        if (call.function?.name) names.add(call.function.name)
      const content = choice.message?.content ?? choice.delta?.content
      if (typeof content === 'string') contents.push(content)
    }
  }
  try {
    const structured = JSON.parse(contents.join('')) as { action?: unknown }
    if (typeof structured.action === 'string') names.add(structured.action)
  } catch {
  }
  return [...names]
}

function sumTokenUsage(
  responses: readonly string[]
): { promptTokens: number; completionTokens: number; totalTokens: number } | '未采集' {
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  let seen = false
  const entries = responses
    .flatMap(responsePayloads)
    .flatMap((payload) => (payload.usage ? [payload.usage] : []))
  for (const entry of entries) {
    seen = true
    usage.promptTokens += entry.prompt_tokens ?? 0
    usage.completionTokens += entry.completion_tokens ?? 0
    usage.totalTokens +=
      entry.total_tokens ?? (entry.prompt_tokens ?? 0) + (entry.completion_tokens ?? 0)
  }
  return seen ? usage : '未采集'
}

interface ProviderPayload {
  choices?: ReadonlyArray<{
    message?: {
      content?: unknown
      tool_calls?: ReadonlyArray<{ function?: { name?: string } }>
    }
    delta?: {
      content?: unknown
      tool_calls?: ReadonlyArray<{ function?: { name?: string } }>
    }
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

function responsePayloads(text: string): readonly ProviderPayload[] {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    try {
      return [JSON.parse(trimmed) as ProviderPayload]
    } catch {
      return []
    }
  }
  const payloads: ProviderPayload[] = []
  for (const line of trimmed.split(/\r?\n/u)) {
    const match = /^data:\s*(.+)$/u.exec(line)
    if (!match || match[1].trim() === '[DONE]') continue
    try {
      payloads.push(JSON.parse(match[1]) as ProviderPayload)
    } catch {
      continue
    }
  }
  return payloads
}

async function environmentEntries(): Promise<Record<string, string>> {
  const entries: Record<string, string> = {}
  for (const line of (await readFile(resolve('.env'), 'utf8')).split(/\r?\n/u)) {
    const trimmed = line.trim()
    const separator = trimmed.indexOf('=')
    if (trimmed.startsWith('#') || separator < 0) continue
    entries[trimmed.slice(0, separator)] = trimmed.slice(separator + 1)
  }
  return entries
}

async function acceptanceSettings(): Promise<ConnectionSettingsInfo> {
  const entries = await environmentEntries()
  const providerId = entries.OPENGALGAME_PROVIDER_ID
  if (
    (providerId !== 'openai-compatible' && providerId !== 'anthropic') ||
    !entries.OPENGALGAME_API_KEY?.trim()
  )
    throw new Error('本机真实模型验收配置缺失')
  return {
    providerId,
    baseUrl: entries.OPENGALGAME_BASE_URL ?? '',
    model: entries.OPENGALGAME_MODEL ?? '',
    apiKey: entries.OPENGALGAME_API_KEY,
    contextWindow: 32000,
    maxOutputTokens: 4000
  }
}

async function p1AcceptanceSettings(): Promise<ConnectionSettingsInfo> {
  const settings = await acceptanceSettings()
  const session = (await environmentEntries()).OPENGALGAME_OPENCODE_SESSION?.trim()
  if (!session) return settings
  return { ...settings, extension: { defaultHeaders: { 'x-opencode-session': session } } }
}

async function acceptance(mode: 'stub' | 'real'): Promise<void> {
  const f = await generationFixture({ keep: root ? join(resolve(root), mode) : undefined })
  const app =
    mode === 'real'
      ? await createSceneGeneration({
          ...f.config,
          loadSettings: p1AcceptanceSettings,
          fetcher: undefined
        })
      : f.app
  await app.generation.generateScene({
    ...request,
    policy: { maxCorrections: 2 }
  })
  await f.run()
  const status = await app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('succeeded')
  expect(status.result!.preview.validationReport.issues).toEqual([])
  expect(status.result!.preview.assetLocations.some((asset) => asset.assetId === 'station')).toBe(
    true
  )
  const execution = (await app.ports.executions.readExecution(request))!
  const report: Record<string, unknown> = {
    modelMode: mode,
    projectRoot: f.projectRoot,
    inputs: execution.inputSnapshot,
    entryFile: join(f.projectRoot, 'game/scene/start.txt'),
    candidateSnapshotId: execution.candidateSnapshotId,
    commitId: status.result!.commitId,
    preview: status.result!.preview,
    budget: execution.budget,
    actionEvidence: '未采集',
    engineSmoke: '未启用'
  }
  if (process.env.OPENGALGAME_RUN_WEBGAL_ENGINE === '1')
    report.engineSmoke = await engineSmoke(f.projectRoot, f.root, status.result!.preview.files)
  await writeFile(join(f.root, 'acceptance-report.json'), JSON.stringify(report, null, 2) + '\n')
  if (root) console.info(`验收证据：${join(f.root, 'acceptance-report.json')}`)
}

function safeExceptionFields(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== 'object') return null
  const record = error as Record<string, unknown>
  const response =
    record.response && typeof record.response === 'object'
      ? (record.response as Record<string, unknown>)
      : null
  const payload = record.payload ?? response?.payload ?? record.body
  return {
    name: typeof record.name === 'string' ? record.name : null,
    status:
      typeof record.status === 'number'
        ? record.status
        : typeof record.statusCode === 'number'
          ? record.statusCode
          : typeof response?.status === 'number'
            ? response.status
            : null,
    ok:
      typeof record.ok === 'boolean'
        ? record.ok
        : typeof response?.ok === 'boolean'
          ? response.ok
          : null,
    code: typeof record.code === 'string' ? record.code : null,
    payloadType:
      payload === undefined
        ? null
        : Array.isArray(payload)
          ? 'array'
          : typeof payload === 'object'
            ? 'object'
            : typeof payload,
    failureClass: typeof record.failureClass === 'string' ? record.failureClass : null,
    reason: typeof record.reason === 'string' ? record.reason : null,
    hasMessage: typeof record.message === 'string' && record.message.length > 0
  }
}

async function writeP1SafeReport(options: {
  f: GenerationFixture
  app: SceneGenerationServices | undefined
  captured: readonly P1Captured[]
  context: P1SafeContext
}): Promise<void> {
  try {
    const settled = await Promise.allSettled(
      options.captured.map((item) => item.capture)
    )
    const captures = settled.flatMap((item) =>
      item.status === 'fulfilled' ? [item.value] : []
    )
    const responses = captures.map((item) => item.text)
    const captureComplete =
      captures.length === options.captured.length &&
      captures.every((item) => item.sawDone || item.termination === 'eof')
    const observedActions = [...new Set(responses.flatMap(responseActions))]
    let statusSnapshot: SceneGenerationStatusVO | undefined
    let execution: SceneGenerationExecution | undefined
    if (options.app) {
      try {
        statusSnapshot = await options.app.status.getSceneGenerationStatus(request)
      } catch {
        statusSnapshot = undefined
      }
      try {
        execution = await options.app.ports.executions.readExecution(request) ?? undefined
      } catch {
        execution = undefined
      }
    }
    const failure = execution?.failure
    const validationIssues =
      statusSnapshot?.result?.preview.validationReport.issues ??
      execution?.artifactValidation?.issues
    const validation = (validationIssues ?? []).map((issue) => ({
      code: typeof issue.code === 'string' ? issue.code : null,
      sequence: typeof issue.sequence === 'number' ? issue.sequence : null,
      line: typeof issue.line === 'number' ? issue.line : null,
      correctable: typeof issue.correctable === 'boolean' ? issue.correctable : null,
      needsDecision:
        typeof issue.requiresHumanDecision === 'boolean'
          ? issue.requiresHumanDecision
          : null
    }))
    const budget = execution?.budget
    const capturedTokenUsage = sumTokenUsage(responses)
    const report = {
      scenario: 'p1-real-model-terminal-actions',
      state: options.context.finalState ?? statusSnapshot?.state ?? null,
      degradedNoticeSeen: options.context.degradedNoticeSeen,
      reviseCount: options.context.reviseCount,
      initialInteractionKind:
        options.context.initialInteractionKind ?? statusSnapshot?.interaction?.kind ?? null,
      candidateSnapshotId:
        options.context.candidateSnapshotId ??
        execution?.candidateSnapshotId ??
        statusSnapshot?.candidateSnapshotId ??
        null,
      commitId: options.context.commitId ?? statusSnapshot?.result?.commitId ?? null,
      validationCount:
        options.context.validationCount ??
        (Array.isArray(validationIssues) ? validationIssues.length : null),
      validation,
      capturedTokenUsage,
      failureClass:
        options.context.failureClass ??
        (failure && 'failureClass' in failure ? (failure.failureClass ?? null) : null),
      failureReason:
        options.context.failureReason ??
        (failure && 'reason' in failure ? (failure.reason ?? null) : null),
      failureCode:
        options.context.failureCode ??
        (failure && 'code' in failure ? (failure.code ?? null) : null),
      httpStatus:
        options.context.httpStatus ??
        (failure && 'httpStatus' in failure ? (failure.httpStatus ?? null) : null),
      observedActions,
      terminalActions: observedActions.filter(isTerminalAction),
      artifactMode: 'p1-real',
      engineSmoke: '未启用',
      captureComplete,
      httpCalls: options.captured.map((item, index) => {
        const capture = captures[index]
        return {
          ...item.http,
          termination: capture?.termination ?? 'unknown',
          sawDone: capture?.sawDone ?? false,
          payloadCount: capture?.payloadCount ?? null,
          parseErrorCount: capture?.parseErrorCount ?? null,
          errorName: capture?.errorName ?? null
        }
      }),
      sdkException: options.context.sdkException,
      budget: budget
        ? {
            correctionsUsed: budget.correctionsUsed,
            modelCallsUsed: budget.modelCallsUsed,
            toolCallsUsed: budget.toolCallsUsed,
            activeElapsedMs: budget.activeElapsedMs,
            inputTokens: budget.inputTokens ?? null,
            outputTokens: budget.outputTokens ?? null,
            totalTokens: budget.totalTokens ?? null,
            tokenLimit: budget.tokenLimit ?? null,
            capturedTokenUsage
          }
        : null
    }
    await writeFile(
      join(options.f.root, 'p1-acceptance-report.json'),
      JSON.stringify(report, null, 2) + '\n'
    )
  } catch (error) {
    if (options.context.sdkException === null) throw error
    await writeFile(
      join(options.f.root, 'p1-evidence-error.json'),
      JSON.stringify(
        {
          primary: options.context.sdkException,
          evidence: safeExceptionFields(error)
        },
        null,
        2
      ) + '\n'
    )
  }
}

async function firstVisibleSentence(projectRoot: string): Promise<string> {
  const raw = await readFile(join(projectRoot, 'game/scene/start.txt'), 'utf8')
  const parser = new SceneParser(
    undefined,
    (fileName) => fileName,
    ADD_NEXT_ARG_LIST,
    SCRIPT_CONFIG
  )
  const scene = parser.parse(raw, 'start.txt', 'start.txt')
  const sentence = scene.sentenceList.find(
    (item) => item.command === 0 && !item.isLineBreakHolder && item.content.trim().length > 0
  )
  if (!sentence) throw new Error('生成脚本没有可显示对白')
  return sentence.content.trim()
}

async function engineVisibleTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const texts: string[] = []
    const renderedCharacters: string[] = []
    for (const element of Array.from(
      document.querySelectorAll('#textBoxMain [class*="TextBox_textElement"]')
    )) {
      const holder = element.querySelector('[class*="_zhanwei_"]') ?? element
      const direct = Array.from(holder.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? '')
        .join('')
      if (direct.trim().length > 0) renderedCharacters.push(direct)
    }
    if (renderedCharacters.length > 0) texts.push(renderedCharacters.join(''))

    const seen = new Set<object>()
    const globalWindow = window as unknown as {
      PIXIapp?: unknown
      __PIXI_APP__?: unknown
    }
    const roots = [globalWindow.PIXIapp, globalWindow.__PIXI_APP__]
    const visit = (node: unknown, depth: number): void => {
      if (!node || typeof node !== 'object' || depth > 12 || seen.has(node)) return
      seen.add(node)
      const record = node as {
        text?: unknown
        children?: unknown[]
        parent?: unknown
        [key: string]: unknown
      }
      if (typeof record.text === 'string') texts.push(record.text)
      if (Array.isArray(record.children)) {
        for (const child of record.children) visit(child, depth + 1)
      }
      for (const key of [
        'currentApp',
        'stage',
        'mainStageContainer',
        'mainStageObject',
        'backgroundContainer',
        'backgroundEffectsContainer',
        'figureContainer',
        'foregroundEffectsContainer',
        'pixiStage',
        'stageManager',
        'text'
      ]) {
        visit(record[key], depth + 1)
      }
    }
    for (const root of roots) visit(root, 0)
    return texts
  })
}

async function engineSmoke(
  projectRoot: string,
  artifactRoot: string,
  files: readonly string[]
): Promise<Record<string, unknown>> {
  const host = new WebgalRuntimeHostImpl({
    projectRoot,
    engineRoot: resolve('node_modules/webgal-engine')
  })
  const requests: Array<{ path: string; statusCode: number }> = []
  host.onRequest((request) => {
    requests.push(request)
  })
  const handle = await host.start()
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    const errors: string[] = []
    page.on('pageerror', (error) => {
      errors.push(error.message)
    })
    await page.goto(handle.baseUrl, { waitUntil: 'networkidle' })
    await page.screenshot({ path: join(artifactRoot, 'engine-loading.png') })
    const expectedSentence = (await firstVisibleSentence(projectRoot))
      .replace(/\s+/gu, ' ')
      .trim()
    await page.getByText('PRESS THE SCREEN TO START', { exact: true }).click({ timeout: 20000 })
    await page
      .getByText('简体中文', { exact: true })
      .filter({ visible: true })
      .first()
      .click({ timeout: 10000 })
    const startButton = page
      .locator('div[class^="_Title_button_"]')
      .filter({ hasText: '开始游戏' })
      .first()
    await startButton.click({ timeout: 20000 })
    await expect
      .poll(
        () =>
          requests.some(
            (request) => request.path === '/game/scene/start.txt' && request.statusCode === 200
          ),
        { timeout: 20000 }
      )
      .toBe(true)
    await expect
      .poll(
        () =>
          requests.some(
            (request) =>
              request.path === '/game/background/station.svg' && request.statusCode === 200
          ),
        { timeout: 20000 }
      )
      .toBe(true)
    await expect
      .poll(
        async () => {
          const rendered = await engineVisibleTexts(page)
          const bodyText = await page.locator('body').innerText()
          const visible =
            [...rendered, bodyText]
              .map((text) => text.replace(/\s+/gu, ' ').trim())
              .some((text) => text.includes(expectedSentence)) ?? false
          if (visible) return true
          await page.locator('#FullScreenClick').click({ position: { x: 640, y: 540 } })
          return false
        },
        { timeout: 20000, interval: 1000 }
      )
      .toBe(true)
    expect(errors).toEqual([])
    const outputDirectory = join(artifactRoot, 'output/playwright')
    await mkdir(outputDirectory, { recursive: true })
    const screenshot = join(outputDirectory, 'engine-scene.png')
    await page.screenshot({ path: screenshot })
    return {
      status: 'passed',
      engineVersion: handle.build.engineVersion,
      scriptFiles: files,
      screenshot,
      requests: requests.filter((request) => request.path.startsWith('/game/'))
    }
  } finally {
    await browser.close()
    await host.dispose()
  }
}
