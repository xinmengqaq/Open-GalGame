import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import type { SceneGenerationInputsDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import { evaluateContextBudget } from '@infrastructure/ai/context/contextBudget'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { FileSkillLoader } from '@infrastructure/ai/skills/FileSkillLoader'
import { SceneGenerationContextAssemblerImpl } from '@infrastructure/scene-generation/agents/context/SceneGenerationContextAssemblerImpl'
import { authorizedInputReadPath } from '@infrastructure/scene-generation/agents/context/authorizedInputs'
import {
  SceneCandidateToolbox,
  createSceneReadAuthority
} from '@infrastructure/scene-generation/pi/SceneCandidateToolbox'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** 与真实画布同形的输入规模：16 卡、19 关系、1 提示词、14 素材、大文档正文。 */
function bulkSnapshot(): SceneGenerationInputsDTO {
  const usage = { targetIds: [] }
  return {
    canvasId: 'canvas-bulk',
    arrangementVersion: 'arrangement-bulk',
    assets: Array.from({ length: 14 }, (_, index) => ({
      assetId: `asset-${index}`,
      sourceId: `source-${index}`,
      name: `素材 ${index}`,
      relativePath: `assets/background/bulk-${index}.webp`,
      category: 'image' as const,
      description: `素材说明 ${index}`,
      usage
    })),
    documents: Array.from({ length: 16 }, (_, index) => ({
      id: `document-${index}`,
      sourceId: `source-${index}`,
      title: `文档 ${index}`,
      summary: `文档摘要 ${index}`,
      body: `文档正文标记-${index}\n${'剧情背景与角色关系说明。'.repeat(300)}`,
      topics: [`主题 ${index}`],
      usage
    })),
    prompts: [
      {
        id: 'prompt-1',
        title: '道别',
        body: `提示词正文标记\n${'用背景开场并保留结尾。'.repeat(160)}`,
        scopes: [{ kind: 'scene' }],
        references: [{ cardId: 'asset-0', kind: 'image', displayName: '背景' }],
        usage
      }
    ],
    fieldBindings: [],
    relations: Array.from({ length: 19 }, (_, index) => ({
      relationId: `relation-${index}`,
      fromCardId: `asset-${index % 14}`,
      toCardId: `asset-${(index + 1) % 14}`,
      defaultRelation: 'associated' as const,
      specificName: `关联 ${index}`,
      record: null
    })),
    confirmedControls: []
  }
}

function executionOf(inputSnapshot: SceneGenerationInputsDTO, workspaceRoot: string): SceneGenerationExecution {
  return {
    projectId: 'project-bulk',
    sceneId: 'scene-bulk',
    operationId: 'operation-bulk',
    threadId: 'thread-bulk',
    branchId: 'branch-bulk',
    source: {
      projectId: 'project-bulk',
      sceneId: 'scene-bulk',
      projectRoot: join(workspaceRoot, '..', 'project'),
      sceneDirectory: 'game/scene',
      entryFile: 'start.txt'
    },
    inputSnapshot,
    replies: [],
    budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 },
    workspace: {
      workspaceId: 'operation-bulk',
      rootDirectory: workspaceRoot,
      sceneDirectory: 'game/scene'
    }
  } as unknown as SceneGenerationExecution
}

it('同形画布只把授权索引标为必需，正文可按读取路径分段获取', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-context-capacity-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  await mkdir(join(workspaceRoot, 'game/scene'), { recursive: true })
  const snapshot = bulkSnapshot()
  const execution = executionOf(snapshot, workspaceRoot)
  const facts = new SceneGenerationContextAssemblerImpl().assemble({
    mode: 'generate',
    execution,
    draft: { path: 'game/scene/start.txt', exists: false, revision: 'absent' },
    skill: { id: 'webgal-scene', digest: 'skill-digest' }
  })

  expect(facts).not.toContain('文档正文标记-0\n')
  const parsed = JSON.parse(facts) as {
    inputs: {
      documents: { readPath: string; charLength: number }[]
      prompts: { readPath: string; charLength: number }[]
    }
  }
  expect(parsed.inputs.documents).toHaveLength(16)
  expect(parsed.inputs.documents[0]?.readPath).toBe(
    authorizedInputReadPath('documents', 'document-0')
  )
  expect(parsed.inputs.documents[0]?.charLength).toBeGreaterThan(3000)
  expect(parsed.inputs.prompts[0]?.readPath).toBe(authorizedInputReadPath('prompts', 'prompt-1'))

  const skill = await new FileSkillLoader(resolve('resources/ai/skills')).load('webgal-scene')
  const systemPrompt = skill.files
    .filter((file) => file.path !== 'SKILL.md')
    .map((file) => `### ${file.path}\n${file.body.trim()}`)
    .join('\n\n')
  const budget = new ExecutionBudget({ modelAttempts: 10, toolCalls: 10, activeMs: 60000 })
  const authority = await createSceneReadAuthority({
    workspaceRoot,
    entryPath: 'game/scene/start.txt',
    inputSnapshot: snapshot
  })
  const toolbox = new SceneCandidateToolbox({
    workspaceRoot,
    entryPath: 'game/scene/start.txt',
    authority,
    budget,
    signal: new AbortController().signal,
    toolResultCharLimit: 8000
  })
  expect(() =>
    evaluateContextBudget({
      windowTokens: 200000,
      safetyFraction: 0.1,
      reservedOutputTokens: 16000,
      inputBudgetTokens: 24000,
      systemPrompt,
      toolDefinitions: toolbox.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      })),
      messages: [{ content: facts, required: true }]
    })
  ).not.toThrow()

  const readPath = parsed.inputs.documents[0]!.readPath
  expect(authority.inputs.get(readPath)?.startsWith('文档正文标记-0')).toBe(true)
  await expect(access(join(workspaceRoot, readPath))).rejects.toMatchObject({ code: 'ENOENT' })
  const reader = new SceneCandidateToolbox({
    workspaceRoot,
    entryPath: 'game/scene/start.txt',
    authority,
    budget,
    signal: new AbortController().signal,
    toolResultCharLimit: 8000
  })
  const readTool = reader.tools.find((tool) => tool.name === 'readTextRange')!
  const result = (await readTool.execute(
    'call-read',
    { path: readPath, start: 0, maxChars: 120 },
    new AbortController().signal
  )) as { details: { content: string; truncated: boolean } }
  expect(result.details.content.startsWith('文档正文标记-0')).toBe(true)
  expect(result.details.truncated).toBe(true)
})
