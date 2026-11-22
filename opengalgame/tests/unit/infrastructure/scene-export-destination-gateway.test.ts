import { lstat, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { LocalSceneExportDestinationGateway } from '@infrastructure/scene-export/LocalSceneExportDestinationGateway'
import { SceneExportErrorCodes } from '@domain/scene-export/errors/SceneExportErrorCodes'

const roots: string[] = []
const scene = { projectId: 'project-1', sceneId: 'scene-1' }
const selectionId = '00000000-0000-4000-8000-000000000000'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('主进程导出目的地', () => {
  it('缺省目的地解析为当前工程根下的 exports，并按需创建', async () => {
    const world = await worldOf()
    let now = 1_000
    const gateway = gatewayOf(world, { now: () => now })

    await expect(
      gateway.resolveDestination(scene, undefined)
    ).resolves.toEqual({
      kind: 'workspace',
      parentDirectory: join(world.projectRoot, 'exports'),
      projectRoot: world.projectRoot
    })
    const second = await gateway.resolveDestination(scene, { kind: 'workspace' })
    expect(second.parentDirectory).toBe(join(world.projectRoot, 'exports'))
    now += 1
  })

  it('重新创建网关后仍解析同一工程默认位置', async () => {
    const world = await worldOf()
    const first = await gatewayOf(world).resolveDestination(scene, undefined)
    const second = await gatewayOf(world).resolveDestination(scene, {
      kind: 'workspace'
    })
    expect(second).toEqual(first)
    expect(first.parentDirectory).toBe(join(world.projectRoot, 'exports'))
  })

  it('选中目录后签发 selectionId，导出只按该身份取回父目录', async () => {
    const world = await worldOf()
    const chosen = join(world.root, 'chosen-parent')
    await mkdir(chosen)
    const gateway = gatewayOf(world, { chooseDirectory: async () => chosen })

    const choice = await gateway.chooseParentDirectory(scene)
    expect(choice).toEqual({
      status: 'selected',
      selectionId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      directoryPath: chosen
    })
    if (choice.status !== 'selected') throw new Error('没有选中目录')
    await expect(
      gateway.resolveDestination(scene, {
        kind: 'selected',
        selectionId: choice.selectionId
      })
    ).resolves.toEqual({
      kind: 'selected',
      parentDirectory: chosen,
      projectRoot: world.projectRoot
    })
  })

  it('同一 selectionId 在 TTL 内可重试复用，不因重试失效', async () => {
    const world = await worldOf()
    const chosen = join(world.root, 'chosen-parent')
    await mkdir(chosen)
    let now = 1_000
    const gateway = gatewayOf(world, {
      chooseDirectory: async () => chosen,
      now: () => now
    })
    const choice = await gateway.chooseParentDirectory(scene)
    if (choice.status !== 'selected') throw new Error('没有选中目录')

    now += 9 * 60 * 1000
    await expect(
      gateway.resolveDestination(scene, {
        kind: 'selected',
        selectionId: choice.selectionId
      })
    ).resolves.toEqual({
      kind: 'selected',
      parentDirectory: chosen,
      projectRoot: world.projectRoot
    })
    now += 2 * 60 * 1000
    await expect(
      gateway.resolveDestination(scene, {
        kind: 'selected',
        selectionId: choice.selectionId
      })
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.destinationRejected })
  })

  it('用户取消目录选择返回 canceled，不创建任何目录', async () => {
    const world = await worldOf()
    const gateway = gatewayOf(world, { chooseDirectory: async () => null })

    await expect(gateway.chooseParentDirectory(scene)).resolves.toEqual({ status: 'canceled' })
    await expect(lstat(join(world.projectRoot, 'exports'))).rejects.toThrow()
    await expect(
      gateway.resolveDestination(scene, {
        kind: 'selected',
        selectionId
      })
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.destinationRejected })
    await expect(
      gateway.resolveDestination(scene, { kind: 'workspace' })
    ).resolves.toMatchObject({ parentDirectory: join(world.projectRoot, 'exports') })
  })

  it('过期、跨场景或未知 selectionId 在打包前拒绝', async () => {
    const world = await worldOf()
    const chosen = join(world.root, 'chosen-parent')
    await mkdir(chosen)
    let now = 1_000
    const gateway = gatewayOf(world, {
      chooseDirectory: async () => chosen,
      now: () => now
    })
    const choice = await gateway.chooseParentDirectory(scene)
    if (choice.status !== 'selected') throw new Error('没有选中目录')

    await expect(
      gateway.resolveDestination(
        { projectId: 'project-1', sceneId: 'other-scene' },
        { kind: 'selected', selectionId: choice.selectionId }
      )
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.destinationRejected })

    now += 11 * 60 * 1000
    await expect(
      gateway.resolveDestination(scene, {
        kind: 'selected',
        selectionId: choice.selectionId
      })
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.destinationRejected })

    await expect(
      gateway.resolveDestination(scene, {
        kind: 'selected',
        selectionId: '11111111-1111-4111-8111-111111111111'
      })
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.destinationRejected })
  })

  it('拒绝工程权威子树、用户状态和受保护根目录', async () => {
    const world = await worldOf()
    const protectedRoot = join(world.root, 'app-resources')
    const cases = [
      join(world.projectRoot, 'game'),
      join(world.projectRoot, 'assets'),
      join(world.projectRoot, '.opengalgame'),
      join(world.projectRoot, '.git'),
      world.userDirectory,
      protectedRoot
    ]
    await Promise.all(cases.map((directory) => mkdir(directory, { recursive: true })))

    for (const directory of cases) {
      const gateway = gatewayOf(world, {
        chooseDirectory: async () => directory,
        protectedRoots: [protectedRoot]
      })
      await expect(gateway.chooseParentDirectory(scene)).rejects.toMatchObject({
        code: SceneExportErrorCodes.destinationRejected
      })
    }
  })

  it('拒绝符号链接父目录和不存在或非目录的位置', async () => {
    const world = await worldOf()
    const real = join(world.root, 'real-parent')
    const link = join(world.root, 'linked-parent')
    const file = join(world.root, 'not-a-directory')
    await mkdir(real)
    await writeFile(file, 'x')
    try {
      await symlink(real, link, 'junction')
    } catch {
      // 当前系统不允许创建该链接时，只覆盖非目录与缺失情况。
    }

    for (const directory of [file, join(world.root, 'missing')]) {
      const gateway = gatewayOf(world, { chooseDirectory: async () => directory })
      await expect(gateway.chooseParentDirectory(scene)).rejects.toMatchObject({
        code: SceneExportErrorCodes.destinationRejected
      })
    }
    if (await isLink(link)) {
      const gateway = gatewayOf(world, { chooseDirectory: async () => link })
      await expect(gateway.chooseParentDirectory(scene)).rejects.toMatchObject({
        code: SceneExportErrorCodes.destinationRejected
      })
    }
  })

  it('工程 exports 是链接或普通文件时拒绝，不跟随目标', async () => {
    const world = await worldOf()
    const outside = join(world.root, 'outside-exports')
    await mkdir(outside)
    const exportsPath = join(world.projectRoot, 'exports')
    try {
      await symlink(outside, exportsPath, 'junction')
    } catch {
      return
    }
    const gateway = gatewayOf(world)
    await expect(gateway.resolveDestination(scene, undefined)).rejects.toMatchObject({
      code: SceneExportErrorCodes.destinationRejected
    })
  })
})

interface World {
  root: string
  projectRoot: string
  userDirectory: string
}

async function worldOf(): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), 'scene-export-destination-'))
  roots.push(root)
  const projectRoot = join(root, 'project')
  const userDirectory = join(root, 'user')
  await mkdir(projectRoot)
  await mkdir(userDirectory)
  await mkdir(join(projectRoot, 'game'))
  await mkdir(join(projectRoot, 'assets'))
  await mkdir(join(projectRoot, '.opengalgame'))
  await mkdir(join(projectRoot, '.git'))
  return { root, projectRoot, userDirectory }
}

function gatewayOf(
  world: World,
  options: {
    chooseDirectory?: () => Promise<string | null>
    protectedRoots?: readonly string[]
    now?: () => number
  } = {}
): LocalSceneExportDestinationGateway {
  return new LocalSceneExportDestinationGateway({
    userDirectory: world.userDirectory,
    chooseDirectory: options.chooseDirectory ?? (async () => null),
    protectedRoots: options.protectedRoots ?? [],
    resolveScene: async () => ({ projectRoot: world.projectRoot }),
    ...(options.now === undefined ? {} : { now: options.now })
  })
}

async function isLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink()
  } catch {
    return false
  }
}
