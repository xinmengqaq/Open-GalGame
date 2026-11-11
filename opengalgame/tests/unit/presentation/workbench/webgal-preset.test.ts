import { describe, expect, it } from 'vitest'

import {
  ANIMATION_PRESET_OPTIONS,
  EFFECT_PRESET_OPTIONS,
  findAnimationPreset,
  findEffectPreset
} from '@presentation/features/workbench-session/webgalPreset'

describe('前端 WebGAL 预设选项', () => {
  it('提供 8 个动画和 13 个特效选项，名称不冲突', () => {
    expect(ANIMATION_PRESET_OPTIONS).toHaveLength(8)
    expect(EFFECT_PRESET_OPTIONS).toHaveLength(13)
    const names = [
      ...ANIMATION_PRESET_OPTIONS.map((item) => item.binding.name),
      ...EFFECT_PRESET_OPTIONS.map((item) => item.binding.name)
    ]
    expect(new Set(names).size).toBe(21)
    expect(findAnimationPreset('enter-from-left')?.binding).toEqual({
      command: 'setAnimation',
      name: 'enter-from-left'
    })
    expect(findEffectPreset('rain')?.binding).toEqual({ command: 'pixiPerform', name: 'rain' })
    expect(findEffectPreset('removeFilm')?.description).toContain('六个电影类滤镜')
    expect(findAnimationPreset('blur')?.description).toContain('从清晰变为模糊')
    expect(findAnimationPreset('rain')).toBeUndefined()
    expect(findEffectPreset('enter')).toBeUndefined()
  })
})
