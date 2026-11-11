import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { ProjectFileAssetKind } from '@application/project-files/vo/ProjectInputSourceVO'
import type { ProjectMediaVO } from '@application/project-files/vo/ProjectMediaVO'

export type ProjectMediaView =
  | {
      status: 'ready'
      url: string
      fileName: string
      mediaType: string
      contentKind: ProjectFileAssetKind
      bytes: Uint8Array
    }
  | { status: 'failed'; code: number | null }

export type MediaCacheSnapshot = ProjectMediaView | { status: 'loading' }

export type MediaAcquire = {
  /** 首次读取或共享同一份在途读取。 */
  result: Promise<ProjectMediaView>
  /** 释放一份引用；最后一个引用释放后撤销 Blob URL 并移除缓存。 */
  release: () => void
}

export type ProjectMediaCache = {
  acquire(sourceId: string, generation?: string, onChange?: () => void): MediaAcquire
  /** 当前来源的稳定快照；尚未读取时为 loading，没有缓存项时为 null。 */
  peek(sourceId: string, generation?: string): MediaCacheSnapshot | null
}

type CacheEntry = {
  refs: number
  settled: boolean
  snapshot: MediaCacheSnapshot
  revoked: boolean
  listeners: Set<() => void>
  revokeTimer: ReturnType<typeof setTimeout> | null
}

interface ProjectMediaCacheDeps {
  read: (sourceId: string) => Promise<AjaxResult<ProjectMediaVO>>
  createObjectUrl?: (blob: Blob) => string
  revokeObjectUrl?: (url: string) => void
}

/**
 * 按来源身份共享一次受控媒体读取。目录与画布同时挂载时只发一次请求；
 * 最后一个消费者卸载（或短暂让位给 React 开发态复跑）后撤销 Blob URL。
 */
export function createProjectMediaCache(deps: ProjectMediaCacheDeps): ProjectMediaCache {
  const createObjectUrl = deps.createObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob))
  const revokeObjectUrl = deps.revokeObjectUrl ?? ((url: string) => URL.revokeObjectURL(url))
  const entries = new Map<string, CacheEntry>()

  function keyOf(sourceId: string, generation = ''): string {
    return generation.length > 0 ? `${sourceId}#${generation}` : sourceId
  }

  function revokeEntry(entry: CacheEntry): void {
    if (entry.revoked || entry.snapshot.status !== 'ready') return
    entry.revoked = true
    revokeObjectUrl(entry.snapshot.url)
  }

  function queueRevoke(key: string, entry: CacheEntry): void {
    if (entry.revokeTimer !== null) return
    // 延后一个任务再撤销：React 开发态会同步重放订阅，期间复用同一份字节。
    entry.revokeTimer = setTimeout(() => {
      entry.revokeTimer = null
      if (entry.refs > 0 || !entry.settled) return
      revokeEntry(entry)
      if (entries.get(key) === entry) entries.delete(key)
    }, 0)
  }

  function settle(key: string, entry: CacheEntry, view: ProjectMediaView): ProjectMediaView {
    entry.settled = true
    entry.snapshot = view
    for (const listener of entry.listeners) listener()
    if (entry.refs <= 0) queueRevoke(key, entry)
    return view
  }

  function readEntry(key: string, sourceId: string): Promise<ProjectMediaView> {
    return deps
      .read(sourceId)
      .then((result) => {
        if (result.code !== ErrorCodes.success || !result.data) {
          return finishRead(key, { status: 'failed', code: result.code })
        }
        const media = result.data
        try {
          const blob = new Blob([media.bytes as BlobPart], { type: media.mediaType })
          return finishRead(key, {
            status: 'ready',
            url: createObjectUrl(blob),
            fileName: media.fileName,
            mediaType: media.mediaType,
            contentKind: media.contentKind,
            bytes: media.bytes
          })
        } catch {
          return finishRead(key, { status: 'failed', code: null })
        }
      })
      .catch(() => finishRead(key, { status: 'failed', code: null }))
  }

  // 读取完成后才拿到当前 entry；用闭包找回同一份缓存项。
  function finishRead(key: string, view: ProjectMediaView): ProjectMediaView {
    const entry = entries.get(key)
    if (!entry) {
      if (view.status === 'ready') revokeObjectUrl(view.url)
      return view
    }
    return settle(key, entry, view)
  }

  function acquire(sourceId: string, generation = '', onChange?: () => void): MediaAcquire {
    const key = keyOf(sourceId, generation)
    let entry = entries.get(key)
    if (!entry) {
      const created: CacheEntry = {
        refs: 0,
        settled: false,
        snapshot: { status: 'loading' },
        revoked: false,
        listeners: new Set(),
        revokeTimer: null
      }
      entries.set(key, created)
      void readEntry(key, sourceId)
      entry = created
    }
    const target = entry
    if (target.revokeTimer !== null) {
      clearTimeout(target.revokeTimer)
      target.revokeTimer = null
    }
    target.refs += 1
    if (onChange) target.listeners.add(onChange)
    const result = new Promise<ProjectMediaView>((resolve) => {
      if (target.settled) {
        resolve(target.snapshot as ProjectMediaView)
        return
      }
      const listener = (): void => {
        if (!target.settled) return
        target.listeners.delete(listener)
        resolve(target.snapshot as ProjectMediaView)
      }
      target.listeners.add(listener)
    })
    let released = false
    return {
      result,
      release: () => {
        if (released) return
        released = true
        if (onChange) target.listeners.delete(onChange)
        target.refs -= 1
        if (target.refs > 0 || !target.settled) return
        queueRevoke(key, target)
      }
    }
  }

  function peek(sourceId: string, generation = ''): MediaCacheSnapshot | null {
    return entries.get(keyOf(sourceId, generation))?.snapshot ?? null
  }

  return { acquire, peek }
}
