/**
 * 文档正文的图片能力关闭规则。
 *
 * 产品决定（S4，P2）：文档正文不再提供图片能力。图片入口按「不可用」处理：
 * 保留节点、隐藏并禁用，不物理删除——md-blockkit 的插入菜单按 DOM 顺序取
 * `querySelectorAll('button')[index]` 聚焦，删节点会让键盘导航和重渲染错位。
 *
 * 升级约定（md-blockkit）：本模块依赖 md-blockkit 的 DOM 结构标记识别图片入口。
 * 升级 md-blockkit 前必须经工作台真实编辑器入口复验（文档层与新建文档）：
 * 图片插入入口保持隐藏或禁用，粘贴与拖入图片被拦截且正文不变。
 * 结构变化时先更新本文件的规则并复验隐藏效果，再升级依赖：
 * 「md-blockkit 的图片入口结构已变化：先更新 documentImageCapability.ts 的规则并复验隐藏效果，再升级依赖」。
 *
 * 边界：只关闭「新增/编辑图片」的入口，历史 Markdown 图片照旧解析与只读渲染；
 * 保存链路里的 unsupported-image 防线不在此处理。
 */
import {
  useCallback,
  useEffect,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { toast } from 'sonner'

import { workbenchFeedback } from '../../feedback/workbenchFeedback'

/** 被关闭入口的标记属性，便于幂等和排查。 */
export const DOCUMENT_IMAGE_UNAVAILABLE_ATTR = 'data-document-image-unavailable'

/**
 * 有稳定结构标记的图片入口。只放 md-blockkit 已知的真实结构；
 * 不用宽泛文案选择器扫描整页，避免误伤正文和宿主界面。
 */
export const DOCUMENT_IMAGE_STRUCTURAL_SELECTORS = [
  'button[aria-label*="图片"]',
  '.block-editor__image-toolbar',
  'input[type="file"][accept*="image"]'
] as const

/** 插入菜单的图片项只有文案、没有 aria-label，只允许在菜单容器内做文案兜底。 */
const DOCUMENT_IMAGE_MENU_ITEM_LABEL = /^(?:上传图片|插入图片|图片)$/
const DOCUMENT_IMAGE_MENU_SCOPE =
  '[role="menu"], .block-editor__insert-menu, .block-editor__block-toolbar'

const DOCUMENT_IMAGE_FILE_EXTENSION = /\.(?:apng|avif|bmp|gif|jpe?g|png|svg|webp)$/i

/** 允许被宿主捕获阶段拦截的点击/变更事件。 */
export interface DocumentImageGuardEvent {
  target?: EventTarget | null
  preventDefault(): void
  stopPropagation(): void
}

/** 剪贴板/拖拽数据项的最小子集，便于单测用普通对象构造。 */
export interface DocumentTransferItemLike {
  kind?: string
  type?: string
}

/** 文件的最小子集，便于单测用普通对象构造。 */
export interface DocumentImageFileLike {
  name?: string
  type?: string
}

/** 剪贴板/拖拽数据源的最小子集。 */
export interface DocumentTransferSourceLike {
  items?: ArrayLike<DocumentTransferItemLike> | null
  files?: ArrayLike<DocumentImageFileLike> | null
  getData?: (format: string) => string
}

export interface DocumentImageTransferEvent extends DocumentImageGuardEvent {
  clipboardData?: DocumentTransferSourceLike | null
  dataTransfer?: DocumentTransferSourceLike | null
}

function normalizeLabel(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function hasDisabledProperty(element: Element): element is Element & { disabled: boolean } {
  return 'disabled' in element
}

/**
 * 插入菜单里的图片项：没有 aria-label、只有文案，且位于菜单容器内。
 * 用在结构选择器之外，作为 md-blockkit 换文案时的兜底。
 */
export function isDocumentImageMenuEntry(element: Element): boolean {
  if (element.tagName !== 'BUTTON') return false
  if (element.closest(DOCUMENT_IMAGE_MENU_SCOPE) === null) return false
  const label = normalizeLabel(element.getAttribute('aria-label') ?? element.textContent)
  return DOCUMENT_IMAGE_MENU_ITEM_LABEL.test(label)
}

/** 找出 root 内所有图片能力入口，不做任何 DOM 改动。 */
export function findDocumentImageEntries(root: ParentNode): Element[] {
  const entries = new Set<Element>()
  for (const selector of DOCUMENT_IMAGE_STRUCTURAL_SELECTORS) {
    for (const element of Array.from(root.querySelectorAll(selector))) entries.add(element)
  }
  for (const button of Array.from(root.querySelectorAll('button'))) {
    if (isDocumentImageMenuEntry(button)) entries.add(button)
  }
  return Array.from(entries)
}

/**
 * 把单个入口置为不可用：保留节点，但隐藏、移出 tab 序、标记 aria-hidden 并禁用。
 * 返回是否真的改动过 DOM，重复调用不会产生新改动（幂等）。
 */
export function hideDocumentImageEntry(entry: Element): boolean {
  let changed = false
  if (entry.getAttribute(DOCUMENT_IMAGE_UNAVAILABLE_ATTR) !== 'true') {
    entry.setAttribute(DOCUMENT_IMAGE_UNAVAILABLE_ATTR, 'true')
    changed = true
  }
  if (entry.getAttribute('aria-hidden') !== 'true') {
    entry.setAttribute('aria-hidden', 'true')
    changed = true
  }
  if (entry.getAttribute('tabindex') !== '-1') {
    entry.setAttribute('tabindex', '-1')
    changed = true
  }
  if (entry instanceof HTMLElement) {
    if (!entry.hidden) {
      entry.hidden = true
      changed = true
    }
    // [hidden] 可能被库的 display 规则覆盖，用行内 !important 兜底。
    const { style } = entry
    if (style.getPropertyValue('display') !== 'none' || style.getPropertyPriority('display') !== 'important') {
      style.setProperty('display', 'none', 'important')
      changed = true
    }
  }
  if (hasDisabledProperty(entry) && !entry.disabled) {
    entry.disabled = true
    changed = true
  }
  return changed
}

/**
 * 对 root 内的图片入口执行一次关闭规则，返回本次改动的节点数。
 * 幂等：第二次调用通常返回 0。
 */
export function applyDocumentImageCapability(root: ParentNode): number {
  let changedCount = 0
  for (const entry of findDocumentImageEntries(root)) {
    if (hideDocumentImageEntry(entry)) changedCount += 1
  }
  return changedCount
}

/**
 * 持续执行关闭规则：库重渲染、切换块、插入菜单等新插入的入口也会被处置。
 * 返回 detach 函数。
 */
export function attachDocumentImageCapability(root: Element): () => void {
  applyDocumentImageCapability(root)
  if (typeof MutationObserver === 'undefined') return () => undefined
  const observer = new MutationObserver(() => {
    applyDocumentImageCapability(root)
  })
  // 只观察结构变化和会影响入口识别的属性，避免把编辑器每次输入都变成一次扫描。
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-label', 'class', 'accept', 'type', 'role']
  })
  return () => observer.disconnect()
}

/** 判断单个文件是否图片：优先看 MIME，MIME 缺失时退回扩展名。 */
export function isDocumentImageFile(file: DocumentImageFileLike | null | undefined): boolean {
  if (!file) return false
  const type = (file.type ?? '').toLowerCase()
  if (type.startsWith('image/')) return true
  return DOCUMENT_IMAGE_FILE_EXTENSION.test(file.name ?? '')
}

/** 文件列表里是否有图片。 */
export function hasDocumentImageFiles(
  files: ArrayLike<DocumentImageFileLike> | null | undefined
): boolean {
  if (!files) return false
  for (let index = 0; index < files.length; index += 1) {
    if (isDocumentImageFile(files[index])) return true
  }
  return false
}

/** 剪贴板/拖拽 item 里是否有图片文件项。 */
export function hasDocumentImageTransferItems(
  items: ArrayLike<DocumentTransferItemLike> | null | undefined
): boolean {
  if (!items) return false
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (!item) continue
    if (item.kind === 'file' && (item.type ?? '').toLowerCase().startsWith('image/')) return true
  }
  return false
}

/** HTML 片段里是否带 <img>（粘贴富文本/拖拽 HTML 的常见载体）。 */
export function htmlContainsDocumentImage(html: string | null | undefined): boolean {
  if (!html) return false
  return /<img\b/i.test(html)
}

/** 读取剪贴板/拖拽里的 HTML，读不到时按空串处理。 */
export function readDocumentTransferHtml(
  source: DocumentTransferSourceLike | null | undefined
): string {
  if (!source || typeof source.getData !== 'function') return ''
  try {
    return source.getData('text/html') ?? ''
  } catch {
    return ''
  }
}

export interface DocumentTransferPayload {
  items?: ArrayLike<DocumentTransferItemLike> | null
  files?: ArrayLike<DocumentImageFileLike> | null
  html?: string | null
}

/**
 * 粘贴/拖入的载荷里是否携带图片：image/* 文件、图片 item，或 HTML 中的 <img>。
 * 纯文本、空数据返回 false。
 */
export function transferPayloadHasDocumentImage(payload: DocumentTransferPayload): boolean {
  return (
    hasDocumentImageTransferItems(payload.items) ||
    hasDocumentImageFiles(payload.files) ||
    htmlContainsDocumentImage(payload.html)
  )
}

function readTransferSource(event: DocumentImageTransferEvent): DocumentTransferSourceLike | null {
  return event.clipboardData ?? event.dataTransfer ?? null
}

function transferEventHasDocumentImage(event: DocumentImageTransferEvent): boolean {
  const source = readTransferSource(event)
  if (!source) return false
  return transferPayloadHasDocumentImage({
    items: source.items,
    files: source.files,
    html: readDocumentTransferHtml(source)
  })
}

function notifyDocumentImageUnavailable(): void {
  toast(workbenchFeedback.documentImageUnavailable)
}

/** 事件目标是否是图片入口（含入口内部子元素）。 */
export function findDocumentImageEntryFromTarget(
  target: EventTarget | null | undefined
): Element | null {
  if (!(target instanceof Element)) return null
  for (const selector of DOCUMENT_IMAGE_STRUCTURAL_SELECTORS) {
    const entry = target.closest(selector)
    if (entry) return entry
  }
  const button = target.closest('button')
  if (button && isDocumentImageMenuEntry(button)) return button
  return null
}

/**
 * 捕获阶段兜底：命中图片入口就阻止默认行为与冒泡，并给出「文档不支持图片」反馈。
 * 返回是否拦截。
 */
export function guardDocumentImageEntryClick(event: DocumentImageGuardEvent): boolean {
  const entry = findDocumentImageEntryFromTarget(event.target)
  if (!entry) return false
  event.preventDefault()
  event.stopPropagation()
  notifyDocumentImageUnavailable()
  return true
}

/** 捕获阶段兜底：拦截图片类 file input 的 change。 */
export function guardDocumentImageFileChange(event: DocumentImageGuardEvent): boolean {
  return guardDocumentImageEntryClick(event)
}

/** 捕获阶段兜底：粘贴携带图片时拦下，正文和光标保持不变，也不让库弹出自己的提示。 */
export function guardDocumentImagePaste(event: DocumentImageTransferEvent): boolean {
  if (!transferEventHasDocumentImage(event)) return false
  event.preventDefault()
  event.stopPropagation()
  notifyDocumentImageUnavailable()
  return true
}

/** 捕获阶段兜底：拖入携带图片时拦下，行为与粘贴一致。 */
export function guardDocumentImageDrop(event: DocumentImageTransferEvent): boolean {
  if (!transferEventHasDocumentImage(event)) return false
  event.preventDefault()
  event.stopPropagation()
  notifyDocumentImageUnavailable()
  return true
}

/**
 * 捕获阶段兜底：拖拽悬停在文档编辑器上、载荷携带图片时，持续阻止浏览器默认行为，
 * 避免浏览器把图片当作导航目标或直接打开文件。dragover 连续触发，这里不弹提示。
 */
export function guardDocumentImageDragOver(event: DocumentImageTransferEvent): boolean {
  if (!transferEventHasDocumentImage(event)) return false
  event.preventDefault()
  event.stopPropagation()
  return true
}

export interface DocumentImageCapabilityGuard {
  /** 挂到包含 DocumentEditor 的容器上；元素挂载/卸载时自动 attach/detach 观察器。 */
  guardRef: (node: HTMLElement | null) => void
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void
  onChangeCapture: (event: ReactChangeEvent<HTMLElement>) => void
  onPasteCapture: (event: ReactClipboardEvent<HTMLElement>) => void
  onDropCapture: (event: ReactDragEvent<HTMLElement>) => void
  /** 拖拽悬停防默认：阻止浏览器把图片拖拽当作导航/打开文件。 */
  onDragEnterCapture: (event: ReactDragEvent<HTMLElement>) => void
  onDragOverCapture: (event: ReactDragEvent<HTMLElement>) => void
}

/**
 * 宿主侧图片能力关闭守卫：容器 ref + 捕获阶段事件处理器。
 * 关闭规则本身在 documentImageCapability 的纯函数里，保留同一入口便于单测。
 */
export function useDocumentImageCapabilityGuard(): DocumentImageCapabilityGuard {
  const [root, setRoot] = useState<HTMLElement | null>(null)
  const guardRef = useCallback((node: HTMLElement | null) => {
    setRoot(node)
  }, [])
  useEffect(() => {
    if (!root) return undefined
    return attachDocumentImageCapability(root)
  }, [root])
  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    guardDocumentImageEntryClick(event)
  }, [])
  const onChangeCapture = useCallback((event: ReactChangeEvent<HTMLElement>) => {
    guardDocumentImageFileChange(event)
  }, [])
  const onPasteCapture = useCallback((event: ReactClipboardEvent<HTMLElement>) => {
    guardDocumentImagePaste(event)
  }, [])
  const onDropCapture = useCallback((event: ReactDragEvent<HTMLElement>) => {
    guardDocumentImageDrop(event)
  }, [])
  const onDragEnterCapture = useCallback((event: ReactDragEvent<HTMLElement>) => {
    guardDocumentImageDragOver(event)
  }, [])
  const onDragOverCapture = useCallback((event: ReactDragEvent<HTMLElement>) => {
    guardDocumentImageDragOver(event)
  }, [])
  return {
    guardRef,
    onClickCapture,
    onChangeCapture,
    onPasteCapture,
    onDropCapture,
    onDragEnterCapture,
    onDragOverCapture
  }
}
