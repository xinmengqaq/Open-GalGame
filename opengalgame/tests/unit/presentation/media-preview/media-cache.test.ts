import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectMediaVO } from '@application/project-files/vo/ProjectMediaVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { createProjectMediaCache } from '@presentation/features/media-preview/mediaCache'

function media(sourceId = 'image-1'): ProjectMediaVO {
  return {
    sourceId,
    contentKind: 'image',
    fileName: 'sora_01.jpg',
    mediaType: 'image/jpeg',
    bytes: new Uint8Array([1, 2, 3, 4])
  }
}

function okResult(data: ProjectMediaVO): AjaxResult<ProjectMediaVO> {
  return { code: ErrorCodes.success, msg: '媒体读取完成', data }
}

function createUrls(): {
  createObjectUrl: (blob: Blob) => string
  revokeObjectUrl: (url: string) => void
  revoked: string[]
} {
  const revoked: string[] = []
  let index = 0
  return {
    createObjectUrl: () => {
      index += 1
      return `blob:media-${index}`
    },
    revokeObjectUrl: (url) => revoked.push(url),
    revoked
  }
}

describe('project media cache', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('按来源共享一次读取并复用同一个 Blob URL', async () => {
    const read = vi.fn((sourceId: string) => Promise.resolve(okResult(media(sourceId))))
    const urls = createUrls()
    const cache = createProjectMediaCache({
      read,
      createObjectUrl: urls.createObjectUrl,
      revokeObjectUrl: urls.revokeObjectUrl
    })

    const first = cache.acquire('image-1')
    const second = cache.acquire('image-1')
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith('image-1')
    expect(cache.peek('image-1')).toEqual({ status: 'loading' })

    const [left, right] = await Promise.all([first.result, second.result])
    expect(left.status).toBe('ready')
    expect(right.status).toBe('ready')
    if (left.status !== 'ready' || right.status !== 'ready') return
    expect(left.url).toBe(right.url)
    expect(left.fileName).toBe('sora_01.jpg')
    expect(left.bytes.byteLength).toBe(4)
    expect(cache.peek('image-1')).toEqual(left)

    first.release()
    vi.advanceTimersByTime(0)
    expect(urls.revoked).toEqual([])
    second.release()
    vi.advanceTimersByTime(0)
    expect(urls.revoked).toEqual([left.url])
    expect(cache.peek('image-1')).toBeNull()
  })

  it('同一任务内重新挂载复用同一份字节，不重复读取', async () => {
    const read = vi.fn((sourceId: string) => Promise.resolve(okResult(media(sourceId))))
    const urls = createUrls()
    const cache = createProjectMediaCache({
      read,
      createObjectUrl: urls.createObjectUrl,
      revokeObjectUrl: urls.revokeObjectUrl
    })

    const first = cache.acquire('image-1')
    const firstView = await first.result
    first.release()
    const again = cache.acquire('image-1')
    const againView = await again.result
    expect(read).toHaveBeenCalledTimes(1)
    expect(firstView.status).toBe('ready')
    expect(againView.status).toBe('ready')
    if (firstView.status !== 'ready' || againView.status !== 'ready') return
    expect(againView.url).toBe(firstView.url)

    again.release()
    vi.advanceTimersByTime(0)
    expect(urls.revoked).toEqual([firstView.url])
  })

  it('读取完成前全部卸载，不保留 Blob URL', async () => {
    const pending = Promise.withResolvers<AjaxResult<ProjectMediaVO>>()
    const read = vi.fn(() => pending.promise)
    const urls = createUrls()
    const cache = createProjectMediaCache({
      read,
      createObjectUrl: urls.createObjectUrl,
      revokeObjectUrl: urls.revokeObjectUrl
    })

    const acquired = cache.acquire('image-1')
    expect(cache.peek('image-1')).toEqual({ status: 'loading' })
    acquired.release()
    pending.resolve(okResult(media()))
    const view = await acquired.result
    expect(view.status).toBe('ready')
    expect(cache.peek('image-1')).toEqual(view)
    vi.advanceTimersByTime(0)
    expect(urls.revoked).toHaveLength(1)
    expect(cache.peek('image-1')).toBeNull()
  })

  it('读取失败返回可回退状态，不创建 Blob URL', async () => {
    const read = vi.fn(() => Promise.resolve({ code: 4315, msg: '文件格式不受支持' }))
    const urls = createUrls()
    const cache = createProjectMediaCache({
      read,
      createObjectUrl: urls.createObjectUrl,
      revokeObjectUrl: urls.revokeObjectUrl
    })

    const acquired = cache.acquire('movie-1')
    const view = await acquired.result
    expect(view).toEqual({ status: 'failed', code: 4315 })
    expect(cache.peek('movie-1')).toEqual({ status: 'failed', code: 4315 })
    acquired.release()
    vi.advanceTimersByTime(0)
    expect(urls.revoked).toEqual([])
    expect(cache.peek('movie-1')).toBeNull()
  })

  it('读取抛错时安全失败；重试代数不同则分开读取', async () => {
    const read = vi.fn((sourceId: string) => {
      return sourceId === 'broken'
        ? Promise.reject(new Error('磁盘读取失败'))
        : Promise.resolve(okResult(media(sourceId)))
    })
    const urls = createUrls()
    const cache = createProjectMediaCache({
      read,
      createObjectUrl: urls.createObjectUrl,
      revokeObjectUrl: urls.revokeObjectUrl
    })

    const broken = cache.acquire('broken')
    expect(await broken.result).toEqual({ status: 'failed', code: null })
    broken.release()

    const current = cache.acquire('image-1', { generation: '1' })
    const next = cache.acquire('image-1', { generation: '2' })
    const [currentView, nextView] = await Promise.all([current.result, next.result])
    expect(read).toHaveBeenCalledTimes(3)
    expect(currentView.status).toBe('ready')
    expect(nextView.status).toBe('ready')
    if (currentView.status !== 'ready' || nextView.status !== 'ready') return
    expect(currentView.url).not.toBe(nextView.url)
    current.release()
    next.release()
    vi.advanceTimersByTime(0)
    expect(urls.revoked).toHaveLength(2)
  })

  it('不同来源在各自最后引用释放后撤销', async () => {
    const read = vi.fn((sourceId: string) => Promise.resolve(okResult(media(sourceId))))
    const urls = createUrls()
    const cache = createProjectMediaCache({
      read,
      createObjectUrl: urls.createObjectUrl,
      revokeObjectUrl: urls.revokeObjectUrl
    })

    const first = cache.acquire('image-1')
    const second = cache.acquire('image-2')
    await Promise.all([first.result, second.result])
    first.release()
    second.release()
    vi.advanceTimersByTime(0)
    expect(urls.revoked).toHaveLength(2)
  })

  it('按 sourceId#generation 分区：同代共享在途读取，不同代分开读取', async () => {
    const pending = Promise.withResolvers<AjaxResult<ProjectMediaVO>>()
    const read = vi.fn(() => pending.promise)
    const urls = createUrls()
    const cache = createProjectMediaCache({
      read,
      createObjectUrl: urls.createObjectUrl,
      revokeObjectUrl: urls.revokeObjectUrl
    })

    const base = cache.acquire('image-1')
    const current = cache.acquire('image-1', { generation: 'retry-1' })
    const shared = cache.acquire('image-1', { generation: 'retry-1' })
    expect(read).toHaveBeenCalledTimes(2)
    expect(cache.peek('image-1')).toEqual({ status: 'loading' })
    expect(cache.peek('image-1', { generation: 'retry-1' })).toEqual({ status: 'loading' })
    expect(cache.peek('image-1', { generation: 'retry-2' })).toBeNull()

    pending.resolve(okResult(media()))
    const [baseView, currentView, sharedView] = await Promise.all([
      base.result,
      current.result,
      shared.result
    ])
    expect(baseView.status).toBe('ready')
    expect(currentView.status).toBe('ready')
    expect(sharedView.status).toBe('ready')
    if (
      baseView.status !== 'ready' ||
      currentView.status !== 'ready' ||
      sharedView.status !== 'ready'
    ) {
      return
    }
    expect(currentView.url).toBe(sharedView.url)
    expect(currentView.url).not.toBe(baseView.url)

    base.release()
    current.release()
    shared.release()
    vi.advanceTimersByTime(0)
    expect(urls.revoked).toHaveLength(2)
  })

  it('peek 在读取前为 null、读取中为 loading、完成后为快照、释放后回到 null', async () => {
    const pending = Promise.withResolvers<AjaxResult<ProjectMediaVO>>()
    const read = vi.fn(() => pending.promise)
    const urls = createUrls()
    const cache = createProjectMediaCache({
      read,
      createObjectUrl: urls.createObjectUrl,
      revokeObjectUrl: urls.revokeObjectUrl
    })

    expect(cache.peek('image-1')).toBeNull()
    const acquired = cache.acquire('image-1')
    expect(cache.peek('image-1')).toEqual({ status: 'loading' })

    pending.resolve(okResult(media()))
    const view = await acquired.result
    expect(cache.peek('image-1')).toEqual(view)

    acquired.release()
    vi.advanceTimersByTime(0)
    expect(cache.peek('image-1')).toBeNull()
  })

  // 负向控制：把 release 改成第一个引用释放就撤销时，本场景必须在首个 release 处失败。
  it('多个引用只在最后一个释放后撤销，重复释放不提前撤销', async () => {
    const read = vi.fn((sourceId: string) => Promise.resolve(okResult(media(sourceId))))
    const urls = createUrls()
    const cache = createProjectMediaCache({
      read,
      createObjectUrl: urls.createObjectUrl,
      revokeObjectUrl: urls.revokeObjectUrl
    })

    const first = cache.acquire('image-1')
    const second = cache.acquire('image-1')
    const third = cache.acquire('image-1')
    const view = await first.result
    await Promise.all([second.result, third.result])
    expect(view.status).toBe('ready')
    if (view.status !== 'ready') return

    first.release()
    first.release()
    vi.advanceTimersByTime(0)
    expect(urls.revoked).toEqual([])
    second.release()
    vi.advanceTimersByTime(0)
    expect(urls.revoked).toEqual([])

    third.release()
    vi.advanceTimersByTime(0)
    expect(urls.revoked).toEqual([view.url])
    third.release()
    vi.advanceTimersByTime(0)
    expect(urls.revoked).toEqual([view.url])
  })

  it('读取完成时通知变更订阅一次，释放后不再通知', async () => {
    const pending = Promise.withResolvers<AjaxResult<ProjectMediaVO>>()
    const read = vi.fn(() => pending.promise)
    const urls = createUrls()
    const cache = createProjectMediaCache({
      read,
      createObjectUrl: urls.createObjectUrl,
      revokeObjectUrl: urls.revokeObjectUrl
    })
    const onChange = vi.fn()

    const acquired = cache.acquire('image-1', { onChange })
    expect(onChange).not.toHaveBeenCalled()
    pending.resolve(okResult(media()))
    await acquired.result
    expect(onChange).toHaveBeenCalledTimes(1)

    acquired.release()
    vi.advanceTimersByTime(0)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(urls.revoked).toHaveLength(1)
  })

  it('最后引用释放并撤销后，再次挂载会重新读取', async () => {
    const read = vi.fn((sourceId: string) => Promise.resolve(okResult(media(sourceId))))
    const urls = createUrls()
    const cache = createProjectMediaCache({
      read,
      createObjectUrl: urls.createObjectUrl,
      revokeObjectUrl: urls.revokeObjectUrl
    })

    const first = cache.acquire('image-1')
    const firstView = await first.result
    first.release()
    vi.advanceTimersByTime(0)
    expect(firstView.status).toBe('ready')
    if (firstView.status !== 'ready') return
    expect(urls.revoked).toEqual([firstView.url])
    expect(cache.peek('image-1')).toBeNull()

    const again = cache.acquire('image-1')
    const againView = await again.result
    expect(read).toHaveBeenCalledTimes(2)
    expect(againView.status).toBe('ready')
    if (againView.status !== 'ready') return
    expect(againView.url).not.toBe(firstView.url)
    again.release()
    vi.advanceTimersByTime(0)
    expect(urls.revoked).toHaveLength(2)
  })
})
