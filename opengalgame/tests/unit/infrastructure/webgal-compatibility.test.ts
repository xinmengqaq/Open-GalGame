import { join } from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

import {
  assertWebgalRuntimeCompatibility,
  inspectWebgalRuntimeBuild,
  installedPackageVersion,
  parserRecognizedCommands,
  WEBGAL_COMPATIBILITY_PROFILE
} from '@infrastructure/webgal/compatibility/WebgalCompatibilityProfile'

describe('WebGAL 固定兼容构建', () => {
  it('核对已安装引擎的构建，解析器版本与引擎相同', async () => {
    const engineVersion = installedPackageVersion(WEBGAL_COMPATIBILITY_PROFILE.enginePackage)
    const engineRoot = join(process.cwd(), 'node_modules', 'webgal-engine')
    const evidence = await assertWebgalRuntimeCompatibility(engineRoot)

    expect(installedPackageVersion(WEBGAL_COMPATIBILITY_PROFILE.parserPackage)).toBe(engineVersion)
    expect(evidence).toMatchObject({
      packageVersion: engineVersion,
      engineVersion,
      entryFile: 'dist/index.html'
    })
    expect(evidence.distDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(parserRecognizedCommands()).toEqual(
      expect.arrayContaining(['say', 'changeBg', 'if', 'chooseLabel', 'playEffect'])
    )
    expect(parserRecognizedCommands()).not.toContain('preview.command.sync-scene')
    await expect(inspectWebgalRuntimeBuild(engineRoot)).resolves.toEqual(evidence)
  })

  it('拒绝与已安装引擎版本不同的运行时构建', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opengalgame-webgal-compatibility-'))
    try {
      await mkdir(join(root, 'dist'), { recursive: true })
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ version: '0.0.0', license: 'MPL-2.0' }),
        'utf8'
      )
      await writeFile(
        join(root, 'dist', 'webgal-engine.json'),
        JSON.stringify({ version: '0.0.0', webgalVersion: '0.0.0', license: 'MPL-2.0' }),
        'utf8'
      )
      await writeFile(join(root, 'dist', 'index.html'), '<!doctype html>', 'utf8')

      await expect(assertWebgalRuntimeCompatibility(root)).rejects.toMatchObject({
        kind: 'incompatible-runtime'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
