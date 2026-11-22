import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import type { SceneGenerationInputsDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { authorizedInputReadPath } from '@infrastructure/scene-generation/agents/context/authorizedInputs'
import {
  SceneCandidateToolbox,
  createSceneReadAuthority
} from '@infrastructure/scene-generation/pi/SceneCandidateToolbox'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function snapshot(): SceneGenerationInputsDTO {
  return {
    canvasId: 'canvas',
    arrangementVersion: 'arrangement',
    assets: [],
    documents: [
      {
        id: 'document-1',
        sourceId: 'source-1',
        title: '当前文档',
        summary: '当前摘要',
        body: 'CURRENT-SECRET',
        topics: [],
        usage: { targetIds: [] }
      }
    ],
    prompts: [],
    fieldBindings: [],
    relations: [],
    confirmedControls: []
  }
}

it('旧候选遗留的授权正文不可枚举、不可读取，新修订只从当前快照取正文', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-authorized-inputs-'))
  roots.push(root)
  const entryPath = 'game/scene/start.txt'
  await mkdir(join(root, 'game/scene'), { recursive: true })
  await writeFile(join(root, entryPath), 'say:种子 -clear;')
  const stalePath = authorizedInputReadPath('documents', 'old-document')
  const staleAbsolute = join(root, stalePath)
  await mkdir(join(staleAbsolute, '..'), { recursive: true })
  await writeFile(staleAbsolute, 'OLD-SECRET')
  await expect(access(staleAbsolute)).resolves.toBeUndefined()

  const authority = await createSceneReadAuthority({
    workspaceRoot: root,
    entryPath,
    inputSnapshot: snapshot()
  })
  expect(authority.files.has(stalePath)).toBe(false)
  const budget = new ExecutionBudget({ modelAttempts: 4, toolCalls: 4, activeMs: 60000 })
  const toolbox = new SceneCandidateToolbox({
    workspaceRoot: root,
    entryPath,
    authority,
    budget,
    signal: new AbortController().signal,
    toolResultCharLimit: 8000
  })
  const listTool = toolbox.tools.find((tool) => tool.name === 'listDirectory')!
  const readTool = toolbox.tools.find((tool) => tool.name === 'readTextRange')!

  const rootListing = (await listTool.execute('call-list', {}, undefined)) as {
    details: { entries: { name: string; kind: string }[] }
  }
  expect(rootListing.details.entries).toEqual([
    { name: '.opengalgame', kind: 'directory' },
    { name: 'game', kind: 'directory' }
  ])
  const inputListing = (await listTool.execute(
    'call-list',
    { path: '.opengalgame/authorized-inputs/documents' },
    undefined
  )) as { details: { entries: { name: string; kind: string }[] } }
  const currentPath = authorizedInputReadPath('documents', 'document-1')
  expect(inputListing.details.entries).toEqual([
    { name: currentPath.split('/').at(-1), kind: 'file' }
  ])
  expect(JSON.stringify(inputListing.details)).not.toContain(stalePath.split('/').at(-1))

  await expect(
    readTool.execute('call-read', { path: stalePath, start: 0, maxChars: 80 }, undefined)
  ).rejects.toThrow('路径不在本次获准读取清单')

  const current = (await readTool.execute(
    'call-read',
    { path: currentPath, start: 0, maxChars: 80 },
    undefined
  )) as { details: { content: string } }
  expect(current.details.content).toBe('CURRENT-SECRET')
  // 当前授权正文只存在内存中，不进入候选工作区或修订。
  await expect(access(join(root, currentPath))).rejects.toMatchObject({ code: 'ENOENT' })
  // 不动旧候选的物理数据，只是不让它进入读取授权。
  await expect(access(staleAbsolute)).resolves.toBeUndefined()
})
