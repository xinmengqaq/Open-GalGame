import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SavedSceneExportSource } from '@application/scene-export/ports/SceneExportSourceGateway'
import { AppException } from '@common/errors/AppException'
import { SceneExportErrorCodes } from '@domain/scene-export/errors/SceneExportErrorCodes'
import {
  EXPORT_MARKER_FILE
} from '@infrastructure/scene-export/exportDestinationPaths'
import {
  assertSourceUnchanged,
  cleanupStaging,
  publishWindowsExport,
  sceneExportDirectoryName,
  TerreWindowsScenePackager
} from '@infrastructure/scene-export/TerreWindowsScenePackager'
import type { LoggerGateway } from '@common/logging/LoggerGateway'

const roots: string[] = []
const logger: LoggerGateway = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}
const source: SavedSceneExportSource = {
  scene: { projectId: 'project-1', sceneId: 'scene-1' },
  contentBasis: {
    digest: 'd'.repeat(64),
    parserVersion: '4.6.5',
    engineVersion: '4.6.5'
  },
  versionReference: { kind: 'preview-save', requestId: 'request-1' },
  entryRelativePath: 'game/scene/start.txt',
  entrySha256: 'b'.repeat(64),
  sceneText: '小明:导出;',
  referencedAssets: []
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Windows 导出原子发布', () => {
  it('在父目录下新建场景子目录，写入归属标记并保留父目录其他文件', async () => {
    const world = await parentWorld()
    await writeFile(join(world.parent, '用户文件.txt'), '保留')
    const staging = await stagingWith(world.root, 'exe-v1', 'asar-v1')

    const directoryName = sceneExportDirectoryName(source)
    await expect(
      publishWindowsExport(staging, world.parent, directoryName, source)
    ).resolves.toBe('published')
    const final = join(world.parent, directoryName)
    expect(await readFile(join(final, 'WebGAL.exe'), 'utf8')).toBe('exe-v1')
    expect(await readFile(join(final, 'resources', 'app.asar'), 'utf8')).toBe('asar-v1')
    expect(await readFile(join(world.parent, '用户文件.txt'), 'utf8')).toBe('保留')
    const marker = JSON.parse(await readFile(join(final, EXPORT_MARKER_FILE), 'utf8')) as {
      formatVersion: number
      files: readonly { relativePath: string; bytes: number; sha256: string }[]
      sourceAssets: unknown[]
    }
    expect(marker).toMatchObject({
      formatVersion: 3,
      projectId: 'project-1',
      sceneId: 'scene-1',
      contentDigest: source.contentBasis.digest,
      directoryName
    })
    expect(marker.files).toEqual([
      {
        relativePath: 'WebGAL.exe',
        bytes: 6,
        sha256: createHash('sha256').update('exe-v1').digest('hex')
      },
      {
        relativePath: 'resources/app.asar',
        bytes: 7,
        sha256: createHash('sha256').update('asar-v1').digest('hex')
      }
    ])
    expect(marker.sourceAssets).toEqual([])
    await expect(lstat(staging)).rejects.toThrow()
  })

  it('同版本同目的地复用完整产物，不覆盖已有字节', async () => {
    const world = await parentWorld()
    const directoryName = sceneExportDirectoryName(source)
    await publishWindowsExport(
      await stagingWith(world.root, 'exe-v1', 'asar-v1'),
      world.parent,
      directoryName,
      source
    )
    const staging = await stagingWith(world.root, 'exe-v2', 'asar-v2')
    await expect(
      publishWindowsExport(staging, world.parent, directoryName, source)
    ).resolves.toBe('reused')
    expect(await readFile(join(world.parent, directoryName, 'WebGAL.exe'), 'utf8')).toBe('exe-v1')
    await rm(staging, { recursive: true, force: true })
  })

  it('同名目录没有归属标记时失败且不覆盖用户内容', async () => {
    const world = await parentWorld()
    const directoryName = sceneExportDirectoryName(source)
    const occupied = join(world.parent, directoryName)
    await mkdir(occupied)
    await writeFile(join(occupied, 'WebGAL.exe'), '用户自己的文件')
    const staging = await stagingWith(world.root, 'exe-v2', 'asar-v2')

    await expect(
      publishWindowsExport(staging, world.parent, directoryName, source)
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.destinationConflict })
    expect(await readFile(join(occupied, 'WebGAL.exe'), 'utf8')).toBe('用户自己的文件')
    await rm(staging, { recursive: true, force: true })
  })

  it('归属标记属于其他版本时不覆盖', async () => {
    const world = await parentWorld()
    const directoryName = sceneExportDirectoryName(source)
    const occupied = join(world.parent, directoryName)
    await mkdir(join(occupied, 'resources'), { recursive: true })
    await writeFile(join(occupied, 'WebGAL.exe'), 'exe-other')
    await writeFile(join(occupied, 'resources', 'app.asar'), 'asar-other')
    await writeFile(
      join(occupied, EXPORT_MARKER_FILE),
      JSON.stringify({
        formatVersion: 1,
        projectId: 'project-1',
        sceneId: 'scene-1',
        contentDigest: 'e'.repeat(64),
        versionReference: source.versionReference,
        directoryName
      })
    )
    const staging = await stagingWith(world.root, 'exe-v2', 'asar-v2')

    await expect(
      publishWindowsExport(staging, world.parent, directoryName, source)
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.destinationConflict })
    expect(await readFile(join(occupied, 'WebGAL.exe'), 'utf8')).toBe('exe-other')
    await rm(staging, { recursive: true, force: true })
  })

  it('本场景归属产物不完整时用备份原子替换', async () => {
    const world = await parentWorld()
    const directoryName = sceneExportDirectoryName(source)
    await publishWindowsExport(
      await stagingWith(world.root, 'exe-v1', 'asar-v1'),
      world.parent,
      directoryName,
      source
    )
    await rm(join(world.parent, directoryName, 'WebGAL.exe'))

    await expect(
      publishWindowsExport(
        await stagingWith(world.root, 'exe-v2', 'asar-v2'),
        world.parent,
        directoryName,
        source
      )
    ).resolves.toBe('published')
    expect(await readFile(join(world.parent, directoryName, 'WebGAL.exe'), 'utf8')).toBe('exe-v2')
    const leftovers = (await readdir(world.parent)).filter((name) =>
      name.startsWith('.scene-export-replaced-')
    )
    expect(leftovers).toEqual([])
  })

  it('同版本发布到两个不同目的地，两边都存在且字节一致', async () => {
    const world = await parentWorld()
    const firstParent = join(world.root, 'first-parent')
    const secondParent = join(world.root, 'second-parent')
    await mkdir(firstParent)
    await mkdir(secondParent)
    const directoryName = sceneExportDirectoryName(source)

    await publishWindowsExport(
      await stagingWith(world.root, 'exe-v1', 'asar-v1'),
      firstParent,
      directoryName,
      source
    )
    await publishWindowsExport(
      await stagingWith(world.root, 'exe-v1', 'asar-v1'),
      secondParent,
      directoryName,
      source
    )
    for (const relative of ['WebGAL.exe', join('resources', 'app.asar')]) {
      expect(await readFile(join(firstParent, directoryName, relative))).toEqual(
        await readFile(join(secondParent, directoryName, relative))
      )
    }
  })

  it('内容摘要或版本引用变化会生成不同产物目录名', () => {
    const directory = sceneExportDirectoryName(source)
    expect(directory).toMatch(/^scene-[a-f0-9]{16}$/u)
    expect(
      sceneExportDirectoryName({
        ...source,
        contentBasis: { ...source.contentBasis, digest: 'e'.repeat(64) }
      })
    ).not.toBe(directory)
    expect(
      sceneExportDirectoryName({
        ...source,
        versionReference: {
          kind: 'generation-commit',
          operationId: 'generation-operation-1',
          commitId: 'a'.repeat(40)
        }
      })
    ).not.toBe(directory)
  })

  it('staging 不完整时在发布前失败，不创建最终目录', async () => {
    const world = await parentWorld()
    const staging = await stagingWith(world.root, 'exe-v1', 'asar-v1')
    await rm(join(staging, 'resources', 'app.asar'))
    const directoryName = 'scene-0000000000000000'

    await expect(
      publishWindowsExport(staging, world.parent, directoryName, source)
    ).rejects.toThrow('staged export incomplete')
    await expect(lstat(join(world.parent, directoryName))).rejects.toThrow()
    await rm(staging, { recursive: true, force: true })
  })

  it('打包器校验缓存产物：删除或同大小改写都返回 false', async () => {
    const world = await parentWorld()
    const directoryName = sceneExportDirectoryName(source)
    await publishWindowsExport(
      await stagingWith(world.root, 'exe-v1', 'asar-v1'),
      world.parent,
      directoryName,
      source
    )
    const packager = new TerreWindowsScenePackager(logger, world.userDirectory)
    const destination = {
      kind: 'selected' as const,
      parentDirectory: world.parent,
      projectRoot: world.projectRoot
    }
    const artifact = {
      executableName: 'WebGAL.exe' as const,
      directoryName,
      directoryPath: join(world.parent, directoryName),
      bytes: 6,
      containsFixedEngine: true as const,
      entryRelativePath: source.entryRelativePath,
      contentBasis: source.contentBasis,
      versionReference: source.versionReference
    }
    await expect(
      packager.verifyWindowsScene(source, destination, artifact)
    ).resolves.toBe(true)
    await writeFile(join(world.parent, directoryName, 'WebGAL.exe'), 'exe-v9')
    await expect(
      packager.verifyWindowsScene(source, destination, artifact)
    ).resolves.toBe(false)
    await writeFile(join(world.parent, directoryName, 'WebGAL.exe'), 'exe-v1')
    await writeFile(join(world.parent, directoryName, 'resources', 'app.asar'), 'asar-v9')
    await expect(
      packager.verifyWindowsScene(source, destination, artifact)
    ).resolves.toBe(false)
    await rm(join(world.parent, directoryName, 'WebGAL.exe'))
    await expect(
      packager.verifyWindowsScene(source, destination, artifact)
    ).resolves.toBe(false)
  })

  it('产物摘要变化时重新发布替换损坏产物，不遗留备份', async () => {
    const world = await parentWorld()
    const directoryName = sceneExportDirectoryName(source)
    await publishWindowsExport(
      await stagingWith(world.root, 'exe-v1', 'asar-v1'),
      world.parent,
      directoryName,
      source
    )
    await writeFile(join(world.parent, directoryName, 'resources', 'app.asar'), 'asar-v9')

    await expect(
      publishWindowsExport(
        await stagingWith(world.root, 'exe-v2', 'asar-v2'),
        world.parent,
        directoryName,
        source
      )
    ).resolves.toBe('published')
    expect(await readFile(join(world.parent, directoryName, 'WebGAL.exe'), 'utf8')).toBe('exe-v2')
    expect(await readFile(join(world.parent, directoryName, 'resources', 'app.asar'), 'utf8')).toBe(
      'asar-v2'
    )
    const leftovers = (await readdir(world.parent)).filter((name) =>
      name.startsWith('.scene-export-replaced-')
    )
    expect(leftovers).toEqual([])
  })

  it('完整分发表单核对 resources.pak 与 locales，删除或同大小改写都会失效并重新发布', async () => {
    const world = await parentWorld()
    const directoryName = sceneExportDirectoryName(source)
    const runtime = {
      'resources/resources.pak': 'pak-v1',
      'locales/zh-CN.pak': 'zh-v1'
    }
    await publishWindowsExport(
      await stagingWith(world.root, 'exe-v1', 'asar-v1', runtime),
      world.parent,
      directoryName,
      source
    )
    const packager = new TerreWindowsScenePackager(logger, world.userDirectory)
    const destination = {
      kind: 'selected' as const,
      parentDirectory: world.parent,
      projectRoot: world.projectRoot
    }
    const artifact = {
      executableName: 'WebGAL.exe' as const,
      directoryName,
      directoryPath: join(world.parent, directoryName),
      bytes: 6,
      containsFixedEngine: true as const,
      entryRelativePath: source.entryRelativePath,
      contentBasis: source.contentBasis,
      versionReference: source.versionReference
    }
    const marker = JSON.parse(
      await readFile(join(world.parent, directoryName, EXPORT_MARKER_FILE), 'utf8')
    ) as { files: readonly { relativePath: string }[] }
    expect(marker.files.map((file) => file.relativePath)).toEqual([
      'WebGAL.exe',
      'locales/zh-CN.pak',
      'resources/app.asar',
      'resources/resources.pak'
    ])
    await expect(
      packager.verifyWindowsScene(source, destination, artifact)
    ).resolves.toBe(true)

    await rm(join(world.parent, directoryName, 'resources', 'resources.pak'))
    await expect(
      packager.verifyWindowsScene(source, destination, artifact)
    ).resolves.toBe(false)
    await expect(
      publishWindowsExport(
        await stagingWith(world.root, 'exe-v1', 'asar-v1', runtime),
        world.parent,
        directoryName,
        source
      )
    ).resolves.toBe('published')
    await expect(
      packager.verifyWindowsScene(source, destination, artifact)
    ).resolves.toBe(true)

    await writeFile(join(world.parent, directoryName, 'locales', 'zh-CN.pak'), 'zh-v9')
    await expect(
      packager.verifyWindowsScene(source, destination, artifact)
    ).resolves.toBe(false)
  })

  it('完整产物允许用户文件并复用；产物损坏且存在用户文件时拒绝替换', async () => {
    const world = await parentWorld()
    const directoryName = sceneExportDirectoryName(source)
    const runtime = { 'resources/resources.pak': 'pak-v1' }
    await publishWindowsExport(
      await stagingWith(world.root, 'exe-v1', 'asar-v1', runtime),
      world.parent,
      directoryName,
      source
    )
    const final = join(world.parent, directoryName)
    await writeFile(join(final, 'USER.txt'), '用户自己的文件')
    const packager = new TerreWindowsScenePackager(logger, world.userDirectory)
    const destination = {
      kind: 'selected' as const,
      parentDirectory: world.parent,
      projectRoot: world.projectRoot
    }
    const artifact = {
      executableName: 'WebGAL.exe' as const,
      directoryName,
      directoryPath: final,
      bytes: 6,
      containsFixedEngine: true as const,
      entryRelativePath: source.entryRelativePath,
      contentBasis: source.contentBasis,
      versionReference: source.versionReference
    }
    await expect(
      packager.verifyWindowsScene(source, destination, artifact)
    ).resolves.toBe(true)
    await expect(
      publishWindowsExport(
        await stagingWith(world.root, 'exe-v1', 'asar-v1', runtime),
        world.parent,
        directoryName,
        source
      )
    ).resolves.toBe('reused')
    expect(await readFile(join(final, 'USER.txt'), 'utf8')).toBe('用户自己的文件')

    await rm(join(final, 'resources', 'resources.pak'))
    const staging = await stagingWith(world.root, 'exe-v1', 'asar-v1', runtime)
    await expect(
      publishWindowsExport(staging, world.parent, directoryName, source)
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.destinationConflict })
    expect(await readFile(join(final, 'USER.txt'), 'utf8')).toBe('用户自己的文件')
    await expect(stat(join(final, 'resources', 'resources.pak'))).rejects.toThrow()
    const leftovers = (await readdir(world.parent)).filter((name) =>
      name.startsWith('.scene-export-replaced-')
    )
    expect(leftovers).toEqual([])
    await rm(staging, { recursive: true, force: true })
  })

  it('旧格式标记目录存在用户文件时拒绝替换', async () => {
    const world = await parentWorld()
    const directoryName = sceneExportDirectoryName(source)
    const final = join(world.parent, directoryName)
    await mkdir(join(final, 'resources'), { recursive: true })
    await writeFile(join(final, 'WebGAL.exe'), 'exe-old')
    await writeFile(join(final, 'resources', 'app.asar'), 'asar-old')
    await writeFile(join(final, 'USER.txt'), '用户自己的文件')
    await writeFile(
      join(final, EXPORT_MARKER_FILE),
      JSON.stringify({
        formatVersion: 2,
        projectId: source.scene.projectId,
        sceneId: source.scene.sceneId,
        contentDigest: source.contentBasis.digest,
        versionReference: source.versionReference,
        directoryName,
        artifact: { executableSha256: 'a'.repeat(64), asarSha256: 'b'.repeat(64) },
        sourceAssets: []
      })
    )
    const staging = await stagingWith(world.root, 'exe-v1', 'asar-v1')
    await expect(
      publishWindowsExport(staging, world.parent, directoryName, source)
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.destinationConflict })
    expect(await readFile(join(final, 'WebGAL.exe'), 'utf8')).toBe('exe-old')
    expect(await readFile(join(final, 'USER.txt'), 'utf8')).toBe('用户自己的文件')
    await rm(staging, { recursive: true, force: true })
  })

  it('组装后重新读取来源，场景或素材变化都会拒绝发布', async () => {
    const world = await parentWorld()
    const digestOf = (value: string): string =>
      createHash('sha256').update(value).digest('hex')
    await mkdir(join(world.projectRoot, 'game', 'scene'), { recursive: true })
    await mkdir(join(world.projectRoot, 'assets'), { recursive: true })
    await writeFile(join(world.projectRoot, 'game', 'scene', 'start.txt'), 'scene-v1')
    await writeFile(join(world.projectRoot, 'assets', 'hero.png'), 'AAAA')
    const withSource: SavedSceneExportSource = {
      ...source,
      entrySha256: digestOf('scene-v1'),
      referencedAssets: [
        { sourcePath: 'assets/hero.png', packagePath: 'game/figure/hero.png' }
      ]
    }
    const packaged = [{ sourcePath: 'assets/hero.png', sha256: digestOf('AAAA') }]
    await expect(
      assertSourceUnchanged(withSource, world.projectRoot, packaged)
    ).resolves.toEqual(packaged)

    await writeFile(join(world.projectRoot, 'assets', 'hero.png'), 'BBBB')
    await expect(
      assertSourceUnchanged(withSource, world.projectRoot, packaged)
    ).rejects.toThrow('source assets changed during packaging')

    await writeFile(join(world.projectRoot, 'assets', 'hero.png'), 'AAAA')
    await writeFile(join(world.projectRoot, 'game', 'scene', 'start.txt'), 'scene-v2')
    await expect(
      assertSourceUnchanged(withSource, world.projectRoot, packaged)
    ).rejects.toThrow('scene changed during packaging')
  })

  it('父目录或 staging 身份变化时跳过清理，避免删错位置', async () => {
    const world = await parentWorld()
    const staging = await mkdtemp(join(world.parent, '.scene-export-staging-test-'))
    const parentInfo = await lstat(world.parent)
    const stagingInfo = await lstat(staging)
    const parentIdentity = { dev: parentInfo.dev, ino: parentInfo.ino }
    const stagingIdentity = { dev: stagingInfo.dev, ino: stagingInfo.ino }

    await cleanupStaging(
      staging,
      world.parent,
      { dev: parentIdentity.dev + 1, ino: parentIdentity.ino },
      stagingIdentity
    )
    await expect(lstat(staging)).resolves.toBeDefined()
    await cleanupStaging(
      staging,
      world.parent,
      parentIdentity,
      { dev: stagingIdentity.dev + 1, ino: stagingIdentity.ino }
    )
    await expect(lstat(staging)).resolves.toBeDefined()
    await cleanupStaging(staging, world.parent, parentIdentity, stagingIdentity)
    await expect(lstat(staging)).rejects.toThrow()
  })

  it('正式引用素材变化会失效缓存，重新发布后标记使用新摘要', async () => {
    const world = await parentWorld()
    const directoryName = sceneExportDirectoryName(source)
    await mkdir(join(world.projectRoot, 'assets'))
    await writeFile(join(world.projectRoot, 'assets', 'hero.png'), 'AAAA')
    const withAsset: SavedSceneExportSource = {
      ...source,
      referencedAssets: [
        { sourcePath: 'assets/hero.png', packagePath: 'game/figure/hero.png' }
      ]
    }
    const digestOf = (value: string): string =>
      createHash('sha256').update(value).digest('hex')
    await publishWindowsExport(
      await stagingWith(world.root, 'exe-v1', 'asar-v1'),
      world.parent,
      directoryName,
      withAsset,
      [{ sourcePath: 'assets/hero.png', sha256: digestOf('AAAA') }]
    )
    const packager = new TerreWindowsScenePackager(logger, world.userDirectory)
    const destination = {
      kind: 'selected' as const,
      parentDirectory: world.parent,
      projectRoot: world.projectRoot
    }
    const artifact = {
      executableName: 'WebGAL.exe' as const,
      directoryName,
      directoryPath: join(world.parent, directoryName),
      bytes: 6,
      containsFixedEngine: true as const,
      entryRelativePath: withAsset.entryRelativePath,
      contentBasis: withAsset.contentBasis,
      versionReference: withAsset.versionReference
    }
    await expect(
      packager.verifyWindowsScene(withAsset, destination, artifact)
    ).resolves.toBe(true)
    await writeFile(join(world.projectRoot, 'assets', 'hero.png'), 'BBBB')
    await expect(
      packager.verifyWindowsScene(withAsset, destination, artifact)
    ).resolves.toBe(false)

    await expect(
      publishWindowsExport(
        await stagingWith(world.root, 'exe-v1', 'asar-v1'),
        world.parent,
        directoryName,
        withAsset,
        [{ sourcePath: 'assets/hero.png', sha256: digestOf('BBBB') }]
      )
    ).resolves.toBe('published')
    const marker = JSON.parse(
      await readFile(join(world.parent, directoryName, EXPORT_MARKER_FILE), 'utf8')
    ) as { sourceAssets: unknown[] }
    expect(marker.sourceAssets).toEqual([
      { sourcePath: 'assets/hero.png', sha256: digestOf('BBBB') }
    ])
    await expect(
      packager.verifyWindowsScene(withAsset, destination, artifact)
    ).resolves.toBe(true)
  })

  it('并发发布者抢到有效产物时返回复用并清理本次备份', async () => {
    const world = await parentWorld()
    const directoryName = sceneExportDirectoryName(source)
    await publishWindowsExport(
      await stagingWith(world.root, 'exe-v1', 'asar-v1'),
      world.parent,
      directoryName,
      source
    )
    await rm(join(world.parent, directoryName, 'WebGAL.exe'))

    const otherParent = join(world.root, 'other-parent')
    await mkdir(otherParent)
    await publishWindowsExport(
      await stagingWith(world.root, 'exe-v1', 'asar-v1'),
      otherParent,
      directoryName,
      source
    )
    const validDirectory = join(otherParent, directoryName)
    let renames = 0
    const staging = await stagingWith(world.root, 'exe-v2', 'asar-v2')
    const result = await publishWindowsExport(
      staging,
      world.parent,
      directoryName,
      source,
      [],
      async (from, to) => {
        renames += 1
        if (renames === 2) {
          await rename(validDirectory, to)
          throw new Error('raced publish')
        }
        await rename(from, to)
      }
    )
    expect(result).toBe('reused')
    expect(renames).toBe(2)
    expect(await readFile(join(world.parent, directoryName, 'WebGAL.exe'), 'utf8')).toBe('exe-v1')
    const leftovers = (await readdir(world.parent)).filter((name) =>
      name.startsWith('.scene-export-replaced-')
    )
    expect(leftovers).toEqual([])
    await rm(staging, { recursive: true, force: true })
  })

  it('目的地真实路径和授权边界在打包前复核', async () => {
    const world = await parentWorld()
    const packager = new TerreWindowsScenePackager(logger, world.userDirectory)
    await mkdir(join(world.projectRoot, 'game'))
    await expect(
      packager.packageWindowsScene(source, {
        kind: 'workspace',
        parentDirectory: world.parent,
        projectRoot: world.projectRoot
      })
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.destinationRejected })
    await expect(
      packager.packageWindowsScene(source, {
        kind: 'selected',
        parentDirectory: join(world.projectRoot, 'game'),
        projectRoot: world.projectRoot
      })
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.destinationRejected })
    const real = join(world.root, 'real-parent')
    const link = join(world.root, 'linked-parent')
    await mkdir(real)
    try {
      await symlink(real, link, 'junction')
    } catch {
      return
    }
    await expect(
      packager.packageWindowsScene(source, {
        kind: 'selected',
        parentDirectory: link,
        projectRoot: world.projectRoot
      })
    ).rejects.toMatchObject({ code: SceneExportErrorCodes.destinationRejected })
  })

  it('有正式引用素材但缺少素材摘要时拒绝发布', async () => {
    const world = await parentWorld()
    const directoryName = 'scene-0000000000000001'
    const withAsset: SavedSceneExportSource = {
      ...source,
      referencedAssets: [
        { sourcePath: 'assets/hero.png', packagePath: 'game/figure/hero.png' }
      ]
    }
    const staging = await stagingWith(world.root, 'exe-v1', 'asar-v1')
    await expect(
      publishWindowsExport(staging, world.parent, directoryName, withAsset)
    ).rejects.toThrow('source asset digests missing')
    await expect(lstat(join(world.parent, directoryName))).rejects.toThrow()
    await rm(staging, { recursive: true, force: true })
  })

  it('目的地父目录被删除时打包失败，不重建父目录或留下半成品', async () => {
    const world = await parentWorld()
    await rm(world.parent, { recursive: true, force: true })
    const packager = new TerreWindowsScenePackager(logger, world.userDirectory)
    await expect(
      packager.packageWindowsScene(source, {
        kind: 'selected',
        parentDirectory: world.parent,
        projectRoot: world.projectRoot
      })
    ).rejects.toBeInstanceOf(AppException)
    await expect(stat(world.parent)).rejects.toThrow()
  })
})

async function parentWorld(): Promise<{
  root: string
  parent: string
  userDirectory: string
  projectRoot: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'scene-export-publish-'))
  roots.push(root)
  const parent = join(root, 'parent')
  const userDirectory = join(root, 'user')
  const projectRoot = join(root, 'project')
  await mkdir(parent)
  await mkdir(userDirectory)
  await mkdir(projectRoot)
  return { root, parent, userDirectory, projectRoot }
}

async function stagingWith(
  root: string,
  exe: string,
  asar: string,
  files: Readonly<Record<string, string>> = {}
): Promise<string> {
  const staging = join(root, `staging-${randomUUID()}`)
  await mkdir(join(staging, 'resources'), { recursive: true })
  await writeFile(join(staging, 'WebGAL.exe'), exe)
  await writeFile(join(staging, 'resources', 'app.asar'), asar)
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(staging, ...relativePath.split('/'))
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content)
  }
  return staging
}
