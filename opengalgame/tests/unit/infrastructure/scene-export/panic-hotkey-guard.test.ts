// @vitest-environment jsdom
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  PANIC_HOTKEY_GUARD_FILE,
  PANIC_HOTKEY_GUARD_SCRIPT,
  writeCopiedTemplatePanicGuard
} from '@infrastructure/scene-export/panicHotkeyGuard'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('导出产物的紧急回避键守卫', () => {
  it('Esc 不再到达引擎 keyup 监听，反引号仍可通过', () => {
    const received: string[] = []
    const listener = (event: Event): void => {
      received.push((event as KeyboardEvent).code)
    }
    document.addEventListener('keyup', listener)
    try {
      new Function(PANIC_HOTKEY_GUARD_SCRIPT)()
      const press = (code: string): void => {
        document.body.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }))
      }
      press('Escape')
      press('Backquote')
      press('KeyA')
      expect(received).toEqual(['Backquote', 'KeyA'])
    } finally {
      document.removeEventListener('keyup', listener)
    }
  })

  it('把守卫脚本放到引擎 module 之前，重复安装拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scene-export-panic-guard-'))
    roots.push(root)
    await writeFile(
      join(root, 'index.html'),
      '<html><head><script type="module" src="./assets/index.js"></script></head><body></body></html>'
    )

    await writeCopiedTemplatePanicGuard(root)

    const html = await readFile(join(root, 'index.html'), 'utf8')
    expect(html).toContain(`<script src="./${PANIC_HOTKEY_GUARD_FILE}"></script>`)
    expect(html.indexOf(PANIC_HOTKEY_GUARD_FILE)).toBeLessThan(
      html.indexOf('<script type="module"')
    )
    expect(await readFile(join(root, PANIC_HOTKEY_GUARD_FILE), 'utf8')).toBe(
      PANIC_HOTKEY_GUARD_SCRIPT
    )
    await expect(writeCopiedTemplatePanicGuard(root)).rejects.toThrow(
      'panic guard already injected'
    )
  })

  it('入口缺少可注入位置时失败，不留下守卫脚本', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scene-export-panic-guard-missing-'))
    roots.push(root)
    await writeFile(join(root, 'index.html'), '<main>no head</main>')

    await expect(writeCopiedTemplatePanicGuard(root)).rejects.toThrow('template head missing')
    await expect(readFile(join(root, PANIC_HOTKEY_GUARD_FILE))).rejects.toThrow()
  })
})
