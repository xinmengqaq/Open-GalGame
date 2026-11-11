// 文档图片能力关闭规则的单元测试。
//
// 默认测试环境是 node（vitest.config.ts: environment: 'node'）。仓库当前没有
// jsdom / happy-dom / linkedom（package.json 与 node_modules 均无），安装 DOM 测试
// 环境需要单独批准，因此依赖 DOM 的用例在缺少 DOM 测试环境时显式跳过；纯函数与
// 反馈文案用例照常执行。若后续批准安装 jsdom，DOM 用例会自动恢复执行。
import { createRequire } from 'node:module'

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: vi.fn() }))

import { toast } from 'sonner'

import {
  DOCUMENT_IMAGE_UNAVAILABLE_ATTR,
  applyDocumentImageCapability,
  attachDocumentImageCapability,
  findDocumentImageEntries,
  guardDocumentImageDragOver,
  guardDocumentImageDrop,
  guardDocumentImageEntryClick,
  guardDocumentImagePaste,
  hasDocumentImageFiles,
  hasDocumentImageTransferItems,
  htmlContainsDocumentImage,
  isDocumentImageFile,
  readDocumentTransferHtml,
  transferPayloadHasDocumentImage,
  type DocumentImageGuardEvent,
  type DocumentImageTransferEvent,
  type DocumentTransferSourceLike
} from '@presentation/features/document-layer/documentImageCapability'
import { workbenchFeedback } from '@presentation/feedback/workbenchFeedback'

const nodeRequire = createRequire(import.meta.url)

function hasDomTestEnvironment(): boolean {
  try {
    nodeRequire.resolve('jsdom')
    return true
  } catch {
    return false
  }
}

const domEnvironmentAvailable = hasDomTestEnvironment()
const DOM_SKIP_REASON =
  '仓库未提供 DOM 测试环境（jsdom / happy-dom / linkedom 均未安装）；DOM 用例跳过，安装依赖需单独批准'

if (!domEnvironmentAvailable) {
  console.info(`[document-image-capability] ${DOM_SKIP_REASON}`)
}

interface JsdomWindowLike {
  document: Document
  HTMLElement: typeof HTMLElement
  Element: typeof Element
  Node: typeof Node
  EventTarget: typeof EventTarget
  MutationObserver: typeof MutationObserver
}

function applyJsdomGlobals(window: JsdomWindowLike): void {
  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    EventTarget: window.EventTarget,
    MutationObserver: window.MutationObserver
  })
}

function rootFromHtml(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

interface RecordedGuardEvent extends DocumentImageGuardEvent {
  prevented: boolean
  stopped: boolean
}

function makeGuardEvent(target: EventTarget | null): RecordedGuardEvent {
  const event: RecordedGuardEvent = {
    target,
    prevented: false,
    stopped: false,
    preventDefault: () => {
      event.prevented = true
    },
    stopPropagation: () => {
      event.stopped = true
    }
  }
  return event
}

interface RecordedTransferEvent extends RecordedGuardEvent, DocumentImageTransferEvent {}

function makeTransferEvent(source: {
  clipboardData?: DocumentTransferSourceLike | null
  dataTransfer?: DocumentTransferSourceLike | null
}): RecordedTransferEvent {
  // 必须就地扩展同一对象：preventDefault/stopPropagation 闭包引用它自身。
  return Object.assign(makeGuardEvent(null), source) as RecordedTransferEvent
}

function flushObserver(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

const TEST_ROOT_HTML = `
  <div class="block-editor__utility-bar">
    <button type="button" aria-label="上传图片" title="上传图片"><span aria-hidden="true">+</span></button>
    <button type="button" aria-label="撤销">撤销</button>
  </div>
  <div class="block-editor__toolbar block-editor__image-toolbar" role="toolbar" aria-label="图片工具">
    <button type="button">替代文本</button>
  </div>
  <input type="file" accept=".jpg,.jpeg,.png,image/png,image/jpeg" />
  <input type="file" accept=".txt,text/plain" />
  <button type="button">正文段落</button>
`

afterEach(() => {
  if (typeof document !== 'undefined') document.body.innerHTML = ''
})

beforeEach(() => {
  vi.mocked(toast).mockClear()
})

describe.skipIf(!domEnvironmentAvailable)('图片入口关闭规则（依赖 DOM 测试环境）', () => {
  beforeAll(async () => {
    if (!domEnvironmentAvailable) return
    const { JSDOM } = await import('jsdom')
    applyJsdomGlobals(new JSDOM('<!doctype html><html><body></body></html>').window as unknown as JsdomWindowLike)
  })

  it('命中图片入口：隐藏、禁用、移出 tab 序并标记 aria-hidden', () => {
    const root = rootFromHtml(TEST_ROOT_HTML)

    const changed = applyDocumentImageCapability(root)

    expect(changed).toBe(3)
    const upload = root.querySelector<HTMLButtonElement>('button[aria-label="上传图片"]')
    const imageToolbar = root.querySelector<HTMLElement>('.block-editor__image-toolbar')
    const imageInput = root.querySelector<HTMLInputElement>('input[type="file"][accept*="image"]')
    expect(upload).not.toBeNull()
    expect(imageToolbar).not.toBeNull()
    expect(imageInput).not.toBeNull()

    for (const entry of [upload, imageToolbar, imageInput] as Array<HTMLElement | null>) {
      expect(entry).not.toBeNull()
      const element = entry as HTMLElement
      expect(element.hidden).toBe(true)
      expect(element.getAttribute('aria-hidden')).toBe('true')
      expect(element.getAttribute('tabindex')).toBe('-1')
      expect(element.getAttribute(DOCUMENT_IMAGE_UNAVAILABLE_ATTR)).toBe('true')
      expect(element.style.getPropertyValue('display')).toBe('none')
      expect(element.style.getPropertyPriority('display')).toBe('important')
    }
    expect(upload?.disabled).toBe(true)
    expect(imageInput?.disabled).toBe(true)

    // 非图片入口不被误伤。
    const undo = root.querySelector<HTMLButtonElement>('button[aria-label="撤销"]')
    const textInput = root.querySelector<HTMLInputElement>('input[accept=".txt,text/plain"]')
    const paragraph = root.querySelectorAll('button')[2]
    expect(undo?.hidden).toBe(false)
    expect(undo?.hasAttribute(DOCUMENT_IMAGE_UNAVAILABLE_ATTR)).toBe(false)
    expect(textInput?.disabled).toBe(false)
    expect(paragraph.hidden).toBe(false)
  })

  it('菜单里的图片项按文案兜底关闭，菜单外的同名文案不误伤', () => {
    const root = rootFromHtml(`
      <div class="block-editor__insert-menu" role="menu">
        <button type="button" role="menuitem">文本</button>
        <button type="button" role="menuitem">上传图片</button>
      </div>
      <div class="block-editor__block-toolbar">
        <button type="button" aria-label="上传图片">上传图片</button>
      </div>
      <div>
        <button type="button">上传图片</button>
      </div>
    `)

    applyDocumentImageCapability(root)

    const menuItems = root.querySelectorAll<HTMLButtonElement>('[role="menu"] button')
    expect(menuItems[0].hidden).toBe(false)
    expect(menuItems[1].hidden).toBe(true)
    expect(root.querySelector<HTMLButtonElement>('.block-editor__block-toolbar button')?.hidden).toBe(
      true
    )
    // 菜单容器外的「上传图片」只是普通文案，不按结构处理。
    const looseButton = root.querySelectorAll<HTMLButtonElement>('div:last-child button')[0]
    expect(looseButton.hidden).toBe(false)
  })

  it('幂等：重复执行不再产生改动', () => {
    const root = rootFromHtml(TEST_ROOT_HTML)
    expect(applyDocumentImageCapability(root)).toBe(3)
    expect(applyDocumentImageCapability(root)).toBe(0)

    // 没有入口时也不抛错。
    expect(applyDocumentImageCapability(rootFromHtml('<p>正文</p>'))).toBe(0)
  })

  it('findDocumentImageEntries 汇总结构入口与菜单兜底', () => {
    const root = rootFromHtml(TEST_ROOT_HTML)
    const entries = findDocumentImageEntries(root)
    expect(entries).toHaveLength(3)
  })

  it('观察新插入的图片入口并隐藏；detach 后不再处理', async () => {
    const root = rootFromHtml('<p>正文</p>')
    document.body.append(root)
    const detach = attachDocumentImageCapability(root)

    root.insertAdjacentHTML(
      'beforeend',
      '<button type="button" aria-label="上传图片">上传图片</button>'
    )
    await flushObserver()
    const inserted = root.querySelector<HTMLButtonElement>('button[aria-label="上传图片"]')
    expect(inserted?.hidden).toBe(true)

    detach()
    root.insertAdjacentHTML('beforeend', '<button type="button" aria-label="更换图片">更换</button>')
    await flushObserver()
    expect(root.querySelector<HTMLButtonElement>('button[aria-label="更换图片"]')?.hidden).toBe(false)
  })

  it('入口属性变化后重新执行关闭规则', async () => {
    const root = rootFromHtml('<button type="button">插入</button>')
    document.body.append(root)
    const detach = attachDocumentImageCapability(root)

    const button = root.querySelector<HTMLButtonElement>('button')
    expect(button?.hidden).toBe(false)
    button?.setAttribute('aria-label', '上传图片')
    await flushObserver()
    expect(button?.hidden).toBe(true)
    detach()
  })

  it('点击图片入口：阻止默认行为与冒泡并给出反馈', () => {
    const root = rootFromHtml('<button type="button" aria-label="上传图片">上传图片</button>')
    const button = root.querySelector('button')
    const event = makeGuardEvent(button)

    expect(guardDocumentImageEntryClick(event)).toBe(true)
    expect(event.prevented).toBe(true)
    expect(event.stopped).toBe(true)
    expect(vi.mocked(toast)).toHaveBeenCalledWith(workbenchFeedback.documentImageUnavailable)
  })

  it('点击入口内部子元素同样被拦截', () => {
    const root = rootFromHtml('<button type="button" aria-label="上传图片"><span>+</span></button>')
    const span = root.querySelector('span')
    const event = makeGuardEvent(span)

    expect(guardDocumentImageEntryClick(event)).toBe(true)
    expect(event.prevented).toBe(true)
  })

  it('普通按钮不拦截、不反馈', () => {
    const root = rootFromHtml('<button type="button">正文段落</button>')
    const event = makeGuardEvent(root.querySelector('button'))

    expect(guardDocumentImageEntryClick(event)).toBe(false)
    expect(event.prevented).toBe(false)
    expect(vi.mocked(toast)).not.toHaveBeenCalled()
  })
})

describe('粘贴/拖入图片判定纯函数', () => {
  it('按 MIME 与扩展名识别图片文件', () => {
    expect(isDocumentImageFile({ type: 'image/png' })).toBe(true)
    expect(isDocumentImageFile({ name: 'photo.JPG', type: '' })).toBe(true)
    expect(isDocumentImageFile({ name: 'note.txt', type: 'text/plain' })).toBe(false)
    expect(isDocumentImageFile(null)).toBe(false)
    expect(isDocumentImageFile(undefined)).toBe(false)
  })

  it('识别文件列表、剪贴板 item 与 HTML 中的图片', () => {
    expect(hasDocumentImageFiles([{ type: 'text/plain' }, { type: 'image/webp' }])).toBe(true)
    expect(hasDocumentImageFiles([])).toBe(false)
    expect(hasDocumentImageFiles(undefined)).toBe(false)

    expect(hasDocumentImageTransferItems([{ kind: 'string', type: 'text/plain' }])).toBe(false)
    expect(hasDocumentImageTransferItems([{ kind: 'file', type: 'image/png' }])).toBe(true)
    expect(hasDocumentImageTransferItems([{ kind: 'file' }])).toBe(false)

    expect(htmlContainsDocumentImage('<p>正文</p><img src="a.png" alt="">')).toBe(true)
    expect(htmlContainsDocumentImage('<IMG SRC="a.png">')).toBe(true)
    expect(htmlContainsDocumentImage('&lt;img src="a.png"&gt;')).toBe(false)
    expect(htmlContainsDocumentImage('<p>纯文本</p>')).toBe(false)
    expect(htmlContainsDocumentImage('')).toBe(false)
  })

  it('汇总载荷判定，纯文本与空数据不拦截', () => {
    expect(transferPayloadHasDocumentImage({ items: [{ kind: 'file', type: 'image/png' }] })).toBe(
      true
    )
    expect(transferPayloadHasDocumentImage({ files: [{ type: 'image/gif' }] })).toBe(true)
    expect(transferPayloadHasDocumentImage({ html: '<img src="a.png">' })).toBe(true)
    expect(transferPayloadHasDocumentImage({ html: '<p>纯文本</p>' })).toBe(false)
    expect(transferPayloadHasDocumentImage({})).toBe(false)
  })

  it('读取 HTML 时容忍缺失与异常', () => {
    expect(readDocumentTransferHtml({ getData: () => '<img src="a.png">' })).toBe(
      '<img src="a.png">'
    )
    expect(
      readDocumentTransferHtml({
        getData: () => {
          throw new Error('clipboard unavailable')
        }
      })
    ).toBe('')
    expect(readDocumentTransferHtml({})).toBe('')
    expect(readDocumentTransferHtml(null)).toBe('')
  })
})

describe('粘贴/拖入捕获守卫', () => {
  it('粘贴 image/* 文件或 HTML 图片时拦截，纯文本与空数据放行', () => {
    const imageItems = makeTransferEvent({
      clipboardData: { items: [{ kind: 'file', type: 'image/png' }], files: [] }
    })
    expect(guardDocumentImagePaste(imageItems)).toBe(true)
    expect(imageItems.prevented).toBe(true)
    expect(imageItems.stopped).toBe(true)
    expect(vi.mocked(toast)).toHaveBeenCalledWith(workbenchFeedback.documentImageUnavailable)

    vi.mocked(toast).mockClear()
    const imageHtml = makeTransferEvent({
      clipboardData: {
        items: [{ kind: 'string', type: 'text/html' }],
        files: [],
        getData: (format) => (format === 'text/html' ? '<p><img src="a.png"></p>' : '')
      }
    })
    expect(guardDocumentImagePaste(imageHtml)).toBe(true)
    expect(vi.mocked(toast)).toHaveBeenCalledTimes(1)

    vi.mocked(toast).mockClear()
    const plainText = makeTransferEvent({
      clipboardData: {
        items: [{ kind: 'string', type: 'text/plain' }],
        files: [],
        getData: () => '纯文本'
      }
    })
    expect(guardDocumentImagePaste(plainText)).toBe(false)
    expect(plainText.prevented).toBe(false)

    const empty = makeTransferEvent({ clipboardData: null })
    expect(guardDocumentImagePaste(empty)).toBe(false)
    expect(vi.mocked(toast)).not.toHaveBeenCalled()
  })

  it('拖入 HTML 图片时拦截，普通拖入放行', () => {
    const imageDrop = makeTransferEvent({
      dataTransfer: {
        items: [],
        files: [],
        getData: (format) => (format === 'text/html' ? '<img src="a.png">' : '')
      }
    })
    expect(guardDocumentImageDrop(imageDrop)).toBe(true)
    expect(imageDrop.prevented).toBe(true)
    expect(vi.mocked(toast)).toHaveBeenCalledWith(workbenchFeedback.documentImageUnavailable)

    vi.mocked(toast).mockClear()
    const plainDrop = makeTransferEvent({
      dataTransfer: { items: [], files: [], getData: () => '<p>正文</p>' }
    })
    expect(guardDocumentImageDrop(plainDrop)).toBe(false)
    expect(vi.mocked(toast)).not.toHaveBeenCalled()
  })
})

describe('拖拽悬停防默认导航', () => {
  it('dataTransfer 携带图片时阻止默认行为与冒泡，且不弹提示', () => {
    const imageOver = makeTransferEvent({
      dataTransfer: { items: [{ kind: 'file', type: 'image/png' }], files: [] }
    })
    expect(guardDocumentImageDragOver(imageOver)).toBe(true)
    expect(imageOver.prevented).toBe(true)
    expect(imageOver.stopped).toBe(true)
    expect(vi.mocked(toast)).not.toHaveBeenCalled()

    const imageHtmlOver = makeTransferEvent({
      dataTransfer: {
        items: [],
        files: [],
        getData: (format) => (format === 'text/html' ? '<img src="a.png">' : '')
      }
    })
    expect(guardDocumentImageDragOver(imageHtmlOver)).toBe(true)
    expect(imageHtmlOver.prevented).toBe(true)
    expect(vi.mocked(toast)).not.toHaveBeenCalled()
  })

  it('不含图片的拖拽不拦截、不弹提示', () => {
    const plainOver = makeTransferEvent({
      dataTransfer: {
        items: [{ kind: 'string', type: 'text/plain' }],
        files: [],
        getData: () => '正文'
      }
    })
    expect(guardDocumentImageDragOver(plainOver)).toBe(false)
    expect(plainOver.prevented).toBe(false)
    expect(plainOver.stopped).toBe(false)
    expect(vi.mocked(toast)).not.toHaveBeenCalled()
  })

  it('没有 dataTransfer 时不抛错并放行', () => {
    const missingTransfer = makeTransferEvent({ dataTransfer: null })
    expect(guardDocumentImageDragOver(missingTransfer)).toBe(false)
    expect(missingTransfer.prevented).toBe(false)
    expect(vi.mocked(toast)).not.toHaveBeenCalled()

    const bareEvent = makeGuardEvent(null)
    expect(guardDocumentImageDragOver(bareEvent)).toBe(false)
    expect(bareEvent.prevented).toBe(false)
  })
})

describe('反馈文案', () => {
  it('图片不可用的提示文案与保存链路的旧防线分开', () => {
    expect(workbenchFeedback.documentImageUnavailable).toBe('文档不支持图片，正文保持原样')
    expect(workbenchFeedback.documentSaveUnsupportedImage).toBe(
      '正文里还有未上传的图片，请先移除后再保存'
    )
  })
})
