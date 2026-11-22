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

export const DOCUMENT_IMAGE_UNAVAILABLE_ATTR = 'data-document-image-unavailable'

export const DOCUMENT_IMAGE_STRUCTURAL_SELECTORS = [
  'button[aria-label*="图片"]',
  '.block-editor__image-toolbar',
  'input[type="file"][accept*="image"]'
] as const

const DOCUMENT_IMAGE_MENU_ITEM_LABEL = /^(?:上传图片|插入图片|图片)$/
const DOCUMENT_IMAGE_MENU_SCOPE =
  '[role="menu"], .block-editor__insert-menu, .block-editor__block-toolbar'

const DOCUMENT_IMAGE_FILE_EXTENSION = /\.(?:apng|avif|bmp|gif|jpe?g|png|svg|webp)$/i

export interface DocumentImageGuardEvent {
  target?: EventTarget | null
  preventDefault(): void
  stopPropagation(): void
}

export interface DocumentTransferItemLike {
  kind?: string
  type?: string
}

export interface DocumentImageFileLike {
  name?: string
  type?: string
}

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

export function isDocumentImageMenuEntry(element: Element): boolean {
  if (element.tagName !== 'BUTTON') return false
  if (element.closest(DOCUMENT_IMAGE_MENU_SCOPE) === null) return false
  const label = normalizeLabel(element.getAttribute('aria-label') ?? element.textContent)
  return DOCUMENT_IMAGE_MENU_ITEM_LABEL.test(label)
}

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

export function applyDocumentImageCapability(root: ParentNode): number {
  let changedCount = 0
  for (const entry of findDocumentImageEntries(root)) {
    if (hideDocumentImageEntry(entry)) changedCount += 1
  }
  return changedCount
}

export function attachDocumentImageCapability(root: Element): () => void {
  applyDocumentImageCapability(root)
  if (typeof MutationObserver === 'undefined') return () => undefined
  const observer = new MutationObserver(() => {
    applyDocumentImageCapability(root)
  })
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-label', 'class', 'accept', 'type', 'role']
  })
  return () => observer.disconnect()
}

export function isDocumentImageFile(file: DocumentImageFileLike | null | undefined): boolean {
  if (!file) return false
  const type = (file.type ?? '').toLowerCase()
  if (type.startsWith('image/')) return true
  return DOCUMENT_IMAGE_FILE_EXTENSION.test(file.name ?? '')
}

export function hasDocumentImageFiles(
  files: ArrayLike<DocumentImageFileLike> | null | undefined
): boolean {
  if (!files) return false
  for (let index = 0; index < files.length; index += 1) {
    if (isDocumentImageFile(files[index])) return true
  }
  return false
}

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

export function htmlContainsDocumentImage(html: string | null | undefined): boolean {
  if (!html) return false
  return /<img\b/i.test(html)
}

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

export function guardDocumentImageEntryClick(event: DocumentImageGuardEvent): boolean {
  const entry = findDocumentImageEntryFromTarget(event.target)
  if (!entry) return false
  event.preventDefault()
  event.stopPropagation()
  notifyDocumentImageUnavailable()
  return true
}

export function guardDocumentImageFileChange(event: DocumentImageGuardEvent): boolean {
  return guardDocumentImageEntryClick(event)
}

export function guardDocumentImagePaste(event: DocumentImageTransferEvent): boolean {
  if (!transferEventHasDocumentImage(event)) return false
  event.preventDefault()
  event.stopPropagation()
  notifyDocumentImageUnavailable()
  return true
}

export function guardDocumentImageDrop(event: DocumentImageTransferEvent): boolean {
  if (!transferEventHasDocumentImage(event)) return false
  event.preventDefault()
  event.stopPropagation()
  notifyDocumentImageUnavailable()
  return true
}

export function guardDocumentImageDragOver(event: DocumentImageTransferEvent): boolean {
  if (!transferEventHasDocumentImage(event)) return false
  event.preventDefault()
  event.stopPropagation()
  return true
}

export interface DocumentImageCapabilityGuard {
  guardRef: (node: HTMLElement | null) => void
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void
  onChangeCapture: (event: ReactChangeEvent<HTMLElement>) => void
  onPasteCapture: (event: ReactClipboardEvent<HTMLElement>) => void
  onDropCapture: (event: ReactDragEvent<HTMLElement>) => void
  onDragEnterCapture: (event: ReactDragEvent<HTMLElement>) => void
  onDragOverCapture: (event: ReactDragEvent<HTMLElement>) => void
}

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
