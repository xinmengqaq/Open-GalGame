import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { expect, it } from 'vitest'
import type { ConnectionSettingsInfo } from '@domain/connections/models/ConnectionSettings'
import { createSceneGeneration } from '@bootstrap/sceneGeneration'
import { WebgalRuntimeHostImpl } from '@infrastructure/webgal/runtime/WebgalRuntimeHostImpl'
import {
  generationFixture,
  request
} from '../../../../harness/acceptance/support/generationFixture'
import { FileSceneGenerationExecutionRepositoryImpl } from '@infrastructure/scene-generation/execution/FileSceneGenerationExecutionRepositoryImpl'

const root = process.env.OPENGALGAME_SCENE_ACCEPTANCE_DIR

it.runIf(process.env.OPENGALGAME_RUN_EXISTING_SCENE_ENGINE === '1')(
  '在已生成的替身和真实模型成品上补验引擎，不重复模型调用',
  async () => {
    if (!root) throw new Error('缺少已有成品目录')
    for (const mode of ['stub', 'real']) {
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
            modelMode: mode,
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
  },
  180000
)

it.runIf(process.env.OPENGALGAME_RUN_SCENE_ACCEPTANCE === '1')(
  '保留替身模型验收工程、修订、提交和真实引擎烟测证据',
  async () => {
    await acceptance('stub')
  },
  180000
)

it.runIf(process.env.OPENGALGAME_RUN_REAL_MODEL === '1')(
  '真实模型通过文件工具生成可提交的真实成品',
  async () => {
    await acceptance('real')
  },
  360000
)

it.runIf(process.env.OPENGALGAME_RUN_REAL_MODEL === '1')(
  '真实模型在同画布完成候选并按终态动作提交',
  async () => {
    const f = await generationFixture({
      keep: root ? join(resolve(root), 'p1-real') : undefined
    })
    const captured: Array<{ tools: readonly string[]; responseText: Promise<string> }> = []
    /** 透传真实请求，同时留存每次工具集与原始响应，供终态动作与技能读取取证。 */
    const capturingFetch: typeof fetch = async (input, init) => {
      const tools = toolNamesOf(init?.body)
      const response = await fetch(input, init)
      captured.push({ tools, responseText: response.clone().text() })
      return response
    }
    const app = await createSceneGeneration({
      ...f.config,
      loadSettings: p1AcceptanceSettings,
      fetcher: capturingFetch
    })
    await app.generation.generateScene({
      ...request,
      reviewCandidate: true,
      policy: { maxCorrections: 2 }
    })
    await f.run()

    const responses = await Promise.all(captured.map((item) => item.responseText))
    const status = await app.status.getSceneGenerationStatus(request)
    const execution = (await app.ports.executions.readExecution(request))!

    expect(captured.length).toBeGreaterThan(0)
    const requestToolSets = captured.map((item) => item.tools).filter((tools) => tools.length > 0)
    expect(requestToolSets.length).toBeGreaterThan(0)
    expect(requestToolSets.every((tools) => !tools.includes('read_file'))).toBe(true)
    const finalResponse = responses.at(-1) ?? ''
    const actionEvidence = responseActions(finalResponse)
    expect(actionEvidence).not.toEqual([])
    expect(actionEvidence.some(isTerminalAction)).toBe(true)
    expect(['waiting', 'succeeded']).toContain(status.state)
    if (status.state === 'waiting') {
      expect(status.interaction?.kind).toBe('review')
      expect(status.candidateSnapshotId).toBeTruthy()
    } else expect(status.result?.commitId).toBeTruthy()
    const candidateSnapshotId = status.candidateSnapshotId ?? execution.candidateSnapshotId
    expect(candidateSnapshotId).toBeTruthy()
    const candidate = await app.ports.artifacts.readCandidate(execution, candidateSnapshotId!)
    expect(candidate.candidateSnapshotId).toBe(candidateSnapshotId)

    const tools = [...new Set(requestToolSets.flat())].sort()
    const observedActions = [...new Set(responses.flatMap(responseActions))]
    const capturedTokenUsage = sumTokenUsage(responses)
    const report = {
      scenario: 'p1-real-model-terminal-actions',
      projectId: status.projectId,
      sceneId: status.sceneId,
      operationId: status.operationId,
      threadId: status.threadId,
      branchId: status.branchId,
      state: status.state,
      interactionKind: status.interaction?.kind ?? null,
      candidateSnapshotId: candidateSnapshotId ?? null,
      commitId: status.result?.commitId ?? null,
      budget: {
        correctionsUsed: execution.budget.correctionsUsed,
        modelCallsUsed: execution.budget.modelCallsUsed,
        toolCallsUsed: execution.budget.toolCallsUsed,
        activeElapsedMs: execution.budget.activeElapsedMs,
        inputTokens: execution.budget.inputTokens ?? null,
        outputTokens: execution.budget.outputTokens ?? null,
        totalTokens: execution.budget.totalTokens ?? null,
        tokenLimit: execution.budget.tokenLimit ?? null,
        capturedTokenUsage
      },
      actionEvidence,
      observedActions,
      tools,
      notes: [
        `策略：maxCorrections 2，reviewCandidate ${String(execution.reviewCandidate)}`,
        `模型请求 ${captured.length} 次，其中 ${requestToolSets.length} 次声明工具；工具集取自各请求 tools[].function.name，所有声明工具集均不含 read_file`,
        `终态动作取自最后一次模型响应的结构化事件（工具调用名与正文 action）：${actionEvidence.join('、') || '未捕获'}；全过程出现过的动作：${observedActions.join('、') || '未捕获'}`,
        capturedTokenUsage === '未采集'
          ? 'Token 未采集：模型响应未包含 usage 字段'
          : 'Token 由各次模型响应 usage.prompt_tokens/completion_tokens 求和',
        `候选修订通过 app.ports.artifacts.readCandidate 读取成功：${candidateSnapshotId}`
      ]
    }
    await writeFile(
      join(f.root, 'p1-acceptance-report.json'),
      JSON.stringify(report, null, 2) + '\n'
    )
    if (root) console.info(`验收证据：${join(f.root, 'p1-acceptance-report.json')}`)
  },
  360000
)

/** 读取请求体里的工具名；兼容 OpenAI 的 `function.name` 与 Anthropic 的顶层 `name`。解析失败直接抛出，避免空工具集让反向断言空过。 */
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

/** 本用例认可的终态动作；只从结构化响应事件读取，不匹配原始文本。 */
const TERMINAL_ACTIONS = ['submit_scene_result', 'report_blocked'] as const

function isTerminalAction(action: string): action is (typeof TERMINAL_ACTIONS)[number] {
  return (TERMINAL_ACTIONS as readonly string[]).includes(action)
}

/** 解析一次响应里的动作名：工具调用名与结构化正文的 action 字段。流式响应按 delta 正文拼接。 */
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
    // 非结构化正文不参与动作取证。
  }
  return [...names]
}

/** 汇总各次响应 usage；支持普通 JSON 响应与 SSE data 行，缺失时返回未采集。 */
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

/** 解析响应文本；普通 JSON 响应与 SSE data 行都还原成同一形状。 */
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

/** 读取本机 .env 的键值；只用于构造连接设置，不写入证据。 */
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

/** 复用既有显式开关和本机 .env 配置，不把凭据写入验收产物。 */
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

/** 在既有真实模型设置上补本机声明的 OpenCode Go 会话头；未配置时保持原设置。 */
async function p1AcceptanceSettings(): Promise<ConnectionSettingsInfo> {
  const settings = await acceptanceSettings()
  const session = (await environmentEntries()).OPENGALGAME_OPENCODE_SESSION?.trim()
  if (!session) return settings
  return { ...settings, extension: { defaultHeaders: { 'x-opencode-session': session } } }
}

/** 用相同应用入口验收，仅替换模型，产物与版本证据全部从真实文件查询。 */
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

/** 加载既有引擎并执行生成入口，证明真实脚本与素材请求可达；不新增播放器。 */
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
          const text = await page.locator('body').innerText()
          if (text.includes('林') || text.includes('车站')) return true
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
