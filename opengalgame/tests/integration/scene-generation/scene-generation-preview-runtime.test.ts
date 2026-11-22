import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { GitCandidatePreviewGatewayImpl } from '@infrastructure/scene-generation/preview/GitCandidatePreviewGatewayImpl'
import { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import { createSceneGeneration } from '@bootstrap/sceneGeneration'
import { ManageProjectVersioning } from '@application/project-versioning/services/impl/ManageProjectVersioning'
import {
  documentBodyPath,
  encodeStorageKey,
  sourceDescriptorPath
} from '@infrastructure/project-files/projectFilePaths'
import { arrangementPath } from '@infrastructure/scene-canvas/sceneCanvasPaths'
import { createProjectVersioningGateways } from '@infrastructure/project-versioning/createProjectVersioningGateways'
import { writeProjectRegistrations } from '@infrastructure/projects/projectRegistrations'
import { streamingFetch } from '../ai/streamingFetch'

const roots: string[] = []
const backgroundPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAkCAIAAAC2bqvFAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAU0lEQVR4nO3PUQkAIBTAwFfSKla1jiH8OITBAtzm7PV1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1owWMX4Vmy07qWCGwAAAAASUVORK5CYII='
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('候选修订可预览真实素材，关闭预览不提交正式作品', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webgal-preview-smoke-'))
  roots.push(root)
  const projectRoot = join(root, 'project')
  await mkdir(join(projectRoot, 'game/scene'), { recursive: true })
  await mkdir(join(projectRoot, 'assets/background'), { recursive: true })
  await mkdir(join(projectRoot, '.opengalgame'), { recursive: true })
  await writeFile(
    join(projectRoot, 'assets/background/sora_01.png'),
    Buffer.from(backgroundPngBase64, 'base64')
  )
  await writeFile(join(projectRoot, 'game/scene/start.txt'), '旁白:原稿;\n')
  await writeFile(
    join(projectRoot, '.opengalgame/manifest.json'),
    JSON.stringify({ projectId: 'project-preview' }) + '\n'
  )
  await writeFile(
    join(projectRoot, '.opengalgame/scene-locks.json'),
    JSON.stringify({ scenes: [{ sceneId: 'scene-preview', lockState: 'unlocked' }] })
  )
  const story = '# 角色与场景\n\n现代校园日常，两名同学放学后站在教学楼外的空地上。\n'
  const prompt = '# 基础生成\n\n根据已选择素材生成一段简短的 WebGAL 场景候选。\n'
  const storyPath = join(projectRoot, documentBodyPath('story-doc', 'md'))
  await mkdir(dirname(storyPath), { recursive: true })
  await writeFile(storyPath, story)
  await writeJson(projectRoot, sourceDescriptorPath('story-doc'), {
    formatVersion: 1,
    projectId: 'project-preview',
    sourceId: 'story-doc',
    content: {
      kind: 'document',
      title: '角色与场景',
      topics: [],
      importFormat: 'markdown',
      bodyFile: `${encodeStorageKey('story-doc')}.md`
    }
  })
  await writeJson(projectRoot, sourceDescriptorPath('sky-image'), {
    formatVersion: 1,
    projectId: 'project-preview',
    sourceId: 'sky-image',
    content: {
      kind: 'asset',
      name: 'sora_01.png',
      fileType: 'image',
      description: '天空背景',
      fileId: 'file-sky-image',
      mediaPath: 'assets/background/sora_01.png'
    }
  })

  await writeJson(projectRoot, arrangementPath('scene-preview', 'canvas-preview'), {
    formatVersion: 3,
    projectId: 'project-preview',
    sceneId: 'scene-preview',
    canvasId: 'canvas-preview',
    viewport: { x: 0, y: 0, zoom: 1 },
    cards: [
      {
        kind: 'document',
        cardId: 'story',
        sourceId: 'story-doc',
        title: '故事',
        summary: '测试故事',
        usage: { targetIds: [] },
        layout: { x: 0, y: 0, width: 300, height: 200 }
      },
      {
        kind: 'prompt',
        cardId: 'prompt',
        title: '基础生成',
        summary: '',
        body: prompt,
        usage: { targetIds: [] },
        layout: { x: 360, y: 0, width: 300, height: 200 }
      },
      {
        kind: 'image',
        cardId: 'sky',
        sourceId: 'sky-image',
        title: '天空',
        role: 'background',
        summary: '',
        usage: { targetIds: [] },
        layout: { x: 720, y: 0, width: 300, height: 200 }
      }
    ],
    relations: []
  })
  git(projectRoot, 'init', '-q')
  git(projectRoot, 'add', '.')
  git(
    projectRoot,
    '-c',
    'user.name=Smoke',
    '-c',
    'user.email=smoke@example.test',
    'commit',
    '-qm',
    '素材基线'
  )
  await writeProjectRegistrations(join(root, 'state'), [
    { id: 'project-preview', directory: projectRoot, operationId: 'register-preview' }
  ])
  let calls = 0
  let writes = 0
  const jobs: Array<() => Promise<void>> = []
  const app = await createSceneGeneration({
    userStateRoot: join(root, 'state'),
    promptRoot: resolve(process.cwd(), 'resources/ai/prompts'),
    registrations: [
      {
        source: {
          projectId: 'project-preview',
          sceneId: 'scene-preview',
          projectRoot,
          sceneDirectory: 'game/scene',
          entryFile: 'start.txt'
        }
      }
    ],
    loadSettings: async () => ({
      providerId: 'openai-compatible',
      baseUrl: 'https://test.example/v1',
      model: 'test',
      apiKey: 'test-secret',
      contextWindow: 200000,
      maxOutputTokens: 16000
    }),
    fetcher: streamingFetch(async (_url, init) => {
      calls += 1
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{
          role?: string
          content?: unknown
          tool_calls?: Array<{ function?: { name?: string } }>
        }>
        tools?: Array<{ function?: { name?: string } }>
      }
      const last = body.messages?.at(-1)
      let call: { name: string; arguments: Record<string, unknown> } | undefined
      if (last?.role === 'user') {
        writes += 1
        call = {
          name: 'writeCandidate',
          arguments: {
            path: 'game/scene/start.txt',
            expectedRevision: expectedRevisionOf(body.messages ?? []),
            content: `say:${writes === 1 ? '第一候选' : '第二候选'} -clear;\nend;\n`
          }
        }
      }
      return Response.json(completion(calls, call))
    }),
    dispatch: (job) => {
      jobs.push(job)
    },
    publishProgress: () => undefined,
    versioning: new ManageProjectVersioning({
      ...createProjectVersioningGateways(join(root, 'state')),
      nextId: () => randomUUID()
    }),
    projects: {
      ensureProjectWorkspace: async () => {
        throw new Error('预览烟测不走启动工作区核对')
      }
    },
    render: {
      canvasVersions: {
        async readArrangementVersion() {
          return {
            projectId: 'project-preview',
            sceneId: 'scene-preview',
            canvasId: 'canvas-preview',
            arrangementVersion: 'unused-by-internal-generation'
          }
        }
      },
      saveArrangement: async () => undefined,
      readCurrentArrangement: async () => null,
      production: {
        async resolveRegisteredScene() {
          throw new Error('内部生成烟测不走生产登记')
        }
      },
      preview: new GitCandidatePreviewGatewayImpl(
        new AiProjectFileSystemImpl(join(root, 'state')),
        join(root, 'state', 'ai')
      )
    }
  })
  const baselineCommit = git(projectRoot, 'rev-parse', 'HEAD')
  const started = await app.generation.generateScene({
    projectId: 'project-preview',
    sceneId: 'scene-preview',
    operationId: 'operation-preview',
    inputs: { canvasId: 'canvas-preview', confirmedControls: [] },
    policy: { maxCorrections: 0 },
    reviewCandidate: true
  })
  await jobs.shift()?.()
  const waiting = await app.status.getSceneGenerationStatus(started)
  expect(waiting.state).toBe('waiting')
  expect(waiting.interaction?.kind).toBe('review')
  const execution = await app.ports.executions.readExecution(started)
  expect(execution?.artifactValidation?.issues).toEqual([])
  expect(execution?.budget.inputTokens).toBeGreaterThan(0)
  expect(execution?.budget.outputTokens).toBeGreaterThan(0)
  expect(waiting.candidateSnapshotId).toBe(execution?.candidateSnapshotId)
  expect(await readFile(join(projectRoot, 'game/scene/start.txt'), 'utf8')).toBe('旁白:原稿;\n')
  expect(git(projectRoot, 'rev-parse', 'HEAD')).toBe(baselineCommit)

  const firstPreview = await app.candidatePreview?.openSceneGenerationCandidatePreview({
    ...started,
    threadId: execution!.threadId,
    branchId: execution!.branchId,
    checkpointId: execution!.checkpointId!,
    candidateSnapshotId: execution!.candidateSnapshotId!
  })
  expect(firstPreview).toBeDefined()
  const origin = originOf(firstPreview!.url)
  const firstScript = await fetch(`${origin}/game/scene/start.txt`)
  const firstAsset = await fetch(`${origin}/game/background/sora_01.png`)
  expect(firstScript.status, '脚本').toBe(200)
  expect(await firstScript.text(), '脚本内容').toContain('第一候选')
  expect(firstAsset.status, '素材').toBe(200)

  await app.candidatePreview?.closeSceneGenerationCandidatePreview({
    ...started,
    previewSessionId: firstPreview!.previewSessionId
  })
  expect((await fetch(firstPreview!.url).catch(() => undefined))?.ok ?? false).toBe(false)
  expect(git(projectRoot, 'rev-parse', 'HEAD')).toBe(baselineCommit)
  await app.close()
}, 60000)

function originOf(url: string): string {
  return new URL(url).origin
}

/** 从 facts 文本块读取 draft.revision，模拟模型按事实写入。 */
function expectedRevisionOf(messages: Array<{ role?: string; content?: unknown }>): string {
  const facts = messages
    .filter((message) => message.role === 'user')
    .map((message) => contentText(message.content))
    .at(-1)
  return facts?.match(/"revision"\s*:\s*"([^"]+)"/)?.[1] ?? 'absent'
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((block) =>
      block && typeof block === 'object' && 'text' in block && typeof block.text === 'string'
        ? [block.text]
        : []
    )
    .join('')
}

function completion(
  call: number,
  tool?: { name: string; arguments: Record<string, unknown> }
): unknown {
  return {
    id: `preview-${call}`,
    object: 'chat.completion',
    created: 1,
    model: 'test',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: tool ? null : '{}',
          ...(tool
            ? {
                tool_calls: [
                  {
                    id: `call-${call}`,
                    type: 'function',
                    function: { name: tool.name, arguments: JSON.stringify(tool.arguments) }
                  }
                ]
              }
            : {})
        },
        finish_reason: tool ? 'tool_calls' : 'stop'
      }
    ],
    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }
  }
}

function git(projectRoot: string, ...args: string[]): string {
  return execFileSync('git', ['-C', projectRoot, ...args], { encoding: 'utf8' }).trim()
}

async function writeJson(projectRoot: string, relativePath: string, value: unknown): Promise<void> {
  const absolute = join(projectRoot, ...relativePath.split('/'))
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, JSON.stringify(value) + '\n')
}
