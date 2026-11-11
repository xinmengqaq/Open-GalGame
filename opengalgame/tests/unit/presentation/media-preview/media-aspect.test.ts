import { describe, expect, it } from 'vitest'

import { mediaFitSize } from '@presentation/features/media-preview/mediaAspect'
import { layoutForNaturalPreview } from '@presentation/features/workbench-session/workbenchSessionMapper'

function ratio(size: { width: number; height: number }): number {
  return size.width / size.height
}

describe('媒体比例规则', () => {
  it('画布贴合与目录缩略图对同一原始尺寸得到同一比例', () => {
    const canvas = layoutForNaturalPreview({ x: 10, y: 20, width: 320, height: 208 }, 1920, 1080)
    const thumbnail = mediaFitSize(1920, 1080, 320, 320)
    expect(canvas).toEqual({ x: 10, y: 20, width: 320, height: 180 })
    expect(thumbnail).toEqual({ width: 320, height: 180 })
    expect(ratio(canvas)).toBeCloseTo(ratio(thumbnail!), 6)
  })

  it('按边界缩小横图与竖图，不裁切', () => {
    expect(mediaFitSize(1920, 1080, 36, 36)).toEqual({ width: 36, height: 20 })
    expect(mediaFitSize(1080, 1920, 100, 100)).toEqual({ width: 56, height: 100 })
    expect(mediaFitSize(4000, 3000, 200, 100)).toEqual({ width: 133, height: 100 })
  })

  it('不放大超过原始尺寸', () => {
    expect(mediaFitSize(64, 32, 320, 320)).toEqual({ width: 64, height: 32 })
    expect(mediaFitSize(1, 1, 320, 320)).toEqual({ width: 1, height: 1 })
  })

  it('非法尺寸不产生预览尺寸', () => {
    expect(mediaFitSize(0, 1080, 320, 320)).toBeNull()
    expect(mediaFitSize(1920, Number.NaN, 320, 320)).toBeNull()
    expect(mediaFitSize(1920, 1080, 0, 320)).toBeNull()
  })
})
