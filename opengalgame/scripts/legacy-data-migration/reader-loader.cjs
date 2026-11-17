'use strict'

const { randomUUID } = require('node:crypto')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const { build } = require('esbuild')

let cached = null

async function loadReader() {
  if (cached !== null) return cached
  const packageRoot = resolve(__dirname, '..', '..')
  const sourceRoot = join(packageRoot, 'src')
  const directory = await mkdtemp(join(tmpdir(), 'opengalgame-r27-reader-'))
  const outfile = join(directory, `reader-${randomUUID()}.cjs`)
  try {
    await build({
      absWorkingDir: packageRoot,
      entryPoints: [join(__dirname, 'reader-bridge.ts')],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      logLevel: 'silent',
      external: ['electron'],
      alias: {
        '@bootstrap': join(sourceRoot, 'bootstrap'),
        '@presentation': join(sourceRoot, 'presentation'),
        '@interfaces': join(sourceRoot, 'interfaces'),
        '@application': join(sourceRoot, 'application'),
        '@domain': join(sourceRoot, 'domain'),
        '@infrastructure': join(sourceRoot, 'infrastructure'),
        '@common': join(sourceRoot, 'common')
      }
    })
    cached = require(outfile)
    return cached
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`R27 生产 reader bridge 装载失败：${message}`)
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}

module.exports = { loadReader }
