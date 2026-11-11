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

    const [left, right] = await Promise.all([first.result, second.result])
    expect(left.status).toBe('ready')
    expect(right.status).toBe('ready')
    if (left.status !== 'ready' || right.status !== 'ready') return
    expect(left.url).toBe(right.url)
    expect(left.fileName).toBe('sora_01.jpg')
    expect(left.bytes.byteLength).toBe(4)

    first.release()
    vi.advanceTimersByTime(0)
    expect(urls.revoked).toEqual([])
    second.release()
    vi.advanceTimersByTime(0)
    expect(urls.revoked).toEqual([left.url])
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
    acquired.release()
    pending.resolve(okResult(media()))
    const view = await acquired.result
    expect(view.status).toBe('ready')
    vi.advanceTimersByTime(0)
    expect(urls.revoked).toHaveLength(1)
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
    acquired.release()
    vi.advanceTimersByTime(0)
    expect(urls.revoked).toEqual([])
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

    const current = cache.acquire('image-1', '1')
    const next = cache.acquire('image-1', '2')
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
})
