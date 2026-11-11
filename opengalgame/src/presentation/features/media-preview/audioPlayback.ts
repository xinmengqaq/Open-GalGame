export interface AudioPlaybackTarget {
  pause(): void
}

export interface AudioPlaybackCoordinator {
  /** 取得独占播放权；正在播放的另一份会立即暂停。 */
  claim(target: AudioPlaybackTarget): void
  /** 暂停或卸载后归还播放权。 */
  release(target: AudioPlaybackTarget): void
  activeTarget(): AudioPlaybackTarget | null
}

/** 全应用只允许一份音频处于播放状态。目录与画布共用同一协调器。 */
export function createAudioPlaybackCoordinator(): AudioPlaybackCoordinator {
  let active: AudioPlaybackTarget | null = null
  return {
    claim(target) {
      if (active !== null && active !== target) active.pause()
      active = target
    },
    release(target) {
      if (active === target) active = null
    },
    activeTarget() {
      return active
    }
  }
}

export const audioPlaybackCoordinator = createAudioPlaybackCoordinator()
