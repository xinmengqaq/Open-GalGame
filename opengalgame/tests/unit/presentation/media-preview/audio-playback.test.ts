import { describe, expect, it } from 'vitest'

import {
  createAudioPlaybackCoordinator,
  type AudioPlaybackTarget
} from '@presentation/features/media-preview/audioPlayback'

type CountedTarget = AudioPlaybackTarget & { pauses: number }

function target(): CountedTarget {
  const counted: CountedTarget = {
    pauses: 0,
    pause: () => {
      counted.pauses += 1
    }
  }
  return counted
}

describe('音频单实例播放', () => {
  it('开始播放另一份时暂停当前一份', () => {
    const coordinator = createAudioPlaybackCoordinator()
    const first = target()
    const second = target()

    coordinator.claim(first)
    expect(coordinator.activeTarget()).toBe(first)

    coordinator.claim(second)
    expect(first.pauses).toBe(1)
    expect(second.pauses).toBe(0)
    expect(coordinator.activeTarget()).toBe(second)
  })

  it('重复认领同一份不暂停自己', () => {
    const coordinator = createAudioPlaybackCoordinator()
    const first = target()

    coordinator.claim(first)
    coordinator.claim(first)
    expect(first.pauses).toBe(0)
    expect(coordinator.activeTarget()).toBe(first)
  })

  it('只有当前一份归还时才清空，旧的归还不会打断新的播放', () => {
    const coordinator = createAudioPlaybackCoordinator()
    const first = target()
    const second = target()

    coordinator.claim(first)
    coordinator.claim(second)
    coordinator.release(first)
    expect(coordinator.activeTarget()).toBe(second)

    coordinator.release(second)
    expect(coordinator.activeTarget()).toBeNull()
  })

  it('暂停事件归还后可以再次认领', () => {
    const coordinator = createAudioPlaybackCoordinator()
    const first = target()
    const second = target()

    coordinator.claim(first)
    coordinator.release(first)
    coordinator.claim(second)
    expect(first.pauses).toBe(0)
    expect(coordinator.activeTarget()).toBe(second)
  })
})
