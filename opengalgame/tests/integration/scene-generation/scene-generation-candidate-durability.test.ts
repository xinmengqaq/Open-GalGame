import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import { readCommitFiles, resolveRefIfExists } from '@infrastructure/git/objects/gitTree'
import {
  generationFixture,
  request
} from '../../../../harness/acceptance/support/generationFixture'

it('没有写出文件时不产生空修订', async () => {
  const f = await generationFixture({ skipWrite: true })
  await f.app.generation.generateScene(request)
  await expect(f.run()).rejects.toThrow(/没有通过工具写入候选脚本/)
  const execution = (await f.app.ports.executions.readExecution(request))!
  expect(execution.state).toBe('failed')
  expect(execution.candidateSnapshotId).toBeUndefined()
  const workspace = new AiProjectFileSystemImpl(f.config.userStateRoot).locateWorkspace(execution)
  await expect(revisionIds(workspace.revisionGitDir)).resolves.toEqual([])
}, 30000)

it('取消生成不发布候选且保留正式作品', async () => {
  const f = await generationFixture({ pauseUntilAbort: true })
  await f.app.generation.generateScene(request)
  const running = f.run()
  await f.app.generation.cancelSceneGeneration(request)
  await running
  const execution = (await f.app.ports.executions.readExecution(request))!
  expect(execution.state).toBe('cancelled')
  expect(execution.candidateSnapshotId).toBeUndefined()
  expect(execution.interaction).toBeUndefined()
  expect(await readFile(join(f.projectRoot, 'game/scene/start.txt'), 'utf8')).toBe('say:原稿;')
}, 30000)

it('工作区清理后已发布修订仍可读取', async () => {
  const f = await generationFixture()
  await f.app.generation.generateScene(request)
  await f.run()
  const execution = (await f.app.ports.executions.readExecution(request))!
  const snapshot = execution.candidateSnapshotId!
  expect(snapshot).toMatch(/^[a-f0-9]{40}$/)
  const workspace = new AiProjectFileSystemImpl(f.config.userStateRoot).locateWorkspace(execution)
  await f.app.ports.workspace.discardWorkspace(execution)
  await expect(lstat(workspace.rootDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(
    resolveRefIfExists(
      { gitdir: workspace.revisionGitDir },
      `refs/opengalgame/revisions/${snapshot}`
    )
  ).resolves.toBe(snapshot)
  const files = await readCommitFiles({ gitdir: workspace.revisionGitDir }, snapshot)
  const entry = files.find((file) => file.relativePath === 'game/scene/start.txt')
  expect(entry).toBeDefined()
  expect(new TextDecoder().decode(entry!.bytes)).toContain('车站的灯亮了')
}, 30000)

async function revisionIds(gitDir: string): Promise<string[]> {
  const refs = await readdir(join(gitDir, 'refs', 'opengalgame', 'revisions')).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    }
  )
  return refs.filter((name) => /^[a-f0-9]{40}$/.test(name)).sort()
}
