import { describe, expect, it } from 'vitest'

import {
  audioWaveformPeaks,
  formatMediaTime
} from '@presentation/features/media-preview/mediaPresentation'

describe('媒体时间文案', () => {
  it('按秒格式化为分秒或时分秒', () => {
    expect(formatMediaTime(0)).toBe('0:00')
    expect(formatMediaTime(5.9)).toBe('0:05')
    expect(formatMediaTime(61)).toBe('1:01')
    expect(formatMediaTime(3661)).toBe('1:01:01')
  })

  it('非法或负时长不显示噪声值', () => {
    expect(formatMediaTime(Number.NaN)).toBe('0:00')
    expect(formatMediaTime(-3)).toBe('0:00')
    expect(formatMediaTime(Number.POSITIVE_INFINITY)).toBe('0:00')
  })
})

describe('音频能量条', () => {
  it('长度与条数一致且落在可视范围内', () => {
    const bytes = new Uint8Array(512)
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 256
    }
    const peaks = audioWaveformPeaks(bytes, 24)
    expect(peaks).toHaveLength(24)
    for (const peak of peaks) {
      expect(peak).toBeGreaterThanOrEqual(0.12)
      expect(peak).toBeLessThanOrEqual(1)
    }
  })

  it('同样的字节得到同样的能量条', () => {
    const bytes = new Uint8Array([0, 32, 64, 96, 128, 160, 192, 224, 255])
    expect(audioWaveformPeaks(bytes, 8)).toEqual(audioWaveformPeaks(bytes, 8))
  })

  it('静音字节也保留最低可见高度，空字节不绘制', () => {
    expect(audioWaveformPeaks(new Uint8Array(64).fill(128), 4)).toEqual([0.12, 0.12, 0.12, 0.12])
    expect(audioWaveformPeaks(new Uint8Array(0), 4)).toEqual([])
    expect(audioWaveformPeaks(new Uint8Array([1, 2]), 0)).toEqual([])
  })
})
