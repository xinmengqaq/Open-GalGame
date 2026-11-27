import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const PANIC_HOTKEY_GUARD_FILE = 'opengalgame-panic-guard.js'

export const PANIC_HOTKEY_GUARD_SCRIPT = `(function () {
  'use strict'
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  window.addEventListener('keyup', function (event) {
    if (event && event.code === 'Escape' && typeof event.stopImmediatePropagation === 'function') {
      event.stopImmediatePropagation()
    }
  }, true)
})()
`

function panicHotkeyGuardTag(): string {
  return `<script src="./${PANIC_HOTKEY_GUARD_FILE}"></script>`
}

function injectPanicHotkeyGuardHtml(html: string): string {
  if (html.includes(PANIC_HOTKEY_GUARD_FILE)) throw new Error('panic guard already injected')
  const engineModule = html.indexOf('<script type="module"')
  const headClose = html.toLowerCase().lastIndexOf('</head>')
  const insertion = engineModule >= 0 ? engineModule : headClose
  if (insertion < 0) throw new Error('template head missing')
  return `${html.slice(0, insertion)}${panicHotkeyGuardTag()}\n${html.slice(insertion)}`
}

export async function writeCopiedTemplatePanicGuard(publicDir: string): Promise<void> {
  const indexPath = path.join(publicDir, 'index.html')
  const html = await readFile(indexPath, 'utf8')
  const guardedHtml = injectPanicHotkeyGuardHtml(html)
  await writeFile(path.join(publicDir, PANIC_HOTKEY_GUARD_FILE), PANIC_HOTKEY_GUARD_SCRIPT)
  await writeFile(indexPath, guardedHtml)
}
