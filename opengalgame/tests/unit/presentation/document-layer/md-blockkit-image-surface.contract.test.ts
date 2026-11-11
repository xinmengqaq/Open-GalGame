import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * md-blockkit 图片入口结构的契约测试。
 *
 * 表现层在 documentImageCapability.ts 里按 DOM 结构关闭图片能力；这些结构来自当前安装的
 * md-blockkit 0.1.0。升级 md-blockkit 后如果图片入口换了标记，宿主会静默漏掉入口，
 * 所以这里在升级时先失败、先提醒更新规则，再允许升级依赖。
 */
const UPGRADE_HINT =
  'md-blockkit 的图片入口结构已变化：先更新 documentImageCapability.ts 的规则并复验隐藏效果，再升级依赖'

const requireFromWorkspace = createRequire(path.join(process.cwd(), 'package.json'))

async function resolveInstalledPackage(): Promise<{
  root: string
  version: string
  bundlePath: string
  bundle: string
}> {
  let styleCssPath: string | null = null
  try {
    styleCssPath = requireFromWorkspace.resolve('md-blockkit/style.css')
  } catch {
    styleCssPath = null
  }

  let current = styleCssPath
    ? path.dirname(styleCssPath)
    : path.join(process.cwd(), 'node_modules', 'md-blockkit', 'dist')

  for (let depth = 0; depth < 8; depth += 1) {
    const manifestPath = path.join(current, 'package.json')
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        name?: string
        version?: string
        main?: string
      }
      if (manifest.name === 'md-blockkit') {
        const main = manifest.main ?? './dist/index.js'
        const bundlePath = path.resolve(current, main)
        return {
          root: current,
          version: manifest.version ?? 'unknown',
          bundlePath,
          bundle: await readFile(bundlePath, 'utf8')
        }
      }
    } catch {
      // 继续向上找 package.json。
    }
    current = path.dirname(current)
  }

  throw new Error(`没有找到已安装的 md-blockkit：${UPGRADE_HINT}`)
}

const installed = await resolveInstalledPackage()

// 升级排查依据：先看版本，再对照下面断言的结构标记。
console.info(`[md-blockkit 契约] 当前安装版本：${installed.version}（${installed.root}）`)

describe('md-blockkit 图片入口结构契约', () => {
  it('图片工具条的容器类名仍在（DocumentImageCapability 依赖）', () => {
    expect(installed.bundle, UPGRADE_HINT).toContain('block-editor__image-toolbar')
  })

  it('工具条与插入菜单的容器类名仍在', () => {
    expect(installed.bundle, UPGRADE_HINT).toContain('block-editor__utility-bar')
    expect(installed.bundle, UPGRADE_HINT).toContain('block-editor__insert-menu')
  })

  it('上传图片入口文案仍在（菜单项与 aria-label 依赖）', () => {
    expect(installed.bundle, UPGRADE_HINT).toContain('上传图片')
  })

  it('图片文件输入的 accept 仍以 image/* 开头（accept*=image 依赖）', () => {
    expect(installed.bundle, UPGRADE_HINT).toContain('image/jpeg')
    expect(installed.bundle, UPGRADE_HINT).toContain('image/png')
  })

  it('库内粘贴图片的提示文案仍存在（宿主捕获阶段拦截的依据）', () => {
    expect(installed.bundle, UPGRADE_HINT).toContain('不支持粘贴图片')
  })
})
