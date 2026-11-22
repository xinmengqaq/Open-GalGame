export interface AudioPlaybackTarget {
  pause(): void
}

export interface AudioPlaybackCoordinator {
  claim(target: AudioPlaybackTarget): void
  release(target: AudioPlaybackTarget): void
  activeTarget(): AudioPlaybackTarget | null
}

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
