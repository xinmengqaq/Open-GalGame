export type WebgalAnimationName =
  | 'enter'
  | 'exit'
  | 'enter-from-left'
  | 'enter-from-bottom'
  | 'enter-from-right'
  | 'shake'
  | 'move-front-and-back'
  | 'blur'

export type WebgalFilterName =
  | 'oldFilm'
  | 'dotFilm'
  | 'reflectionFilm'
  | 'glitchFilm'
  | 'rgbFilm'
  | 'godrayFilm'
  | 'removeFilm'
  | 'shockwaveIn'
  | 'shockwaveOut'

export type WebgalStageEffectName = 'rain' | 'snow' | 'heavySnow' | 'cherryBlossoms'

export type AnimationPresetBinding = {
  command: 'setAnimation'
  name: WebgalAnimationName
}

export type EffectPresetBinding =
  | { command: 'setAnimation'; name: WebgalFilterName }
  | { command: 'pixiPerform'; name: WebgalStageEffectName }

export type SessionFieldKind = 'animation' | 'effect'

export type PresetOption<TBinding> = {
  label: string
  description: string
  binding: TBinding
}

export const ANIMATION_PRESET_OPTIONS: readonly PresetOption<AnimationPresetBinding>[] = [
  {
    label: '渐入',
    description: '对象逐渐显示。',
    binding: { command: 'setAnimation', name: 'enter' }
  },
  {
    label: '渐出',
    description: '对象逐渐消失。',
    binding: { command: 'setAnimation', name: 'exit' }
  },
  {
    label: '从左侧进入',
    description: '对象从画面左侧进入。',
    binding: { command: 'setAnimation', name: 'enter-from-left' }
  },
  {
    label: '从下侧进入',
    description: '对象从画面下侧进入。',
    binding: { command: 'setAnimation', name: 'enter-from-bottom' }
  },
  {
    label: '从右侧进入',
    description: '对象从画面右侧进入。',
    binding: { command: 'setAnimation', name: 'enter-from-right' }
  },
  {
    label: '左右摇晃',
    description: '对象左右摇晃。',
    binding: { command: 'setAnimation', name: 'shake' }
  },
  {
    label: '前后移动',
    description: '对象前后移动。',
    binding: { command: 'setAnimation', name: 'move-front-and-back' }
  },
  {
    label: '模糊',
    description: '从清晰变为模糊。',
    binding: { command: 'setAnimation', name: 'blur' }
  }
]

export const EFFECT_PRESET_OPTIONS: readonly PresetOption<EffectPresetBinding>[] = [
  {
    label: '老电影',
    description: '套用老电影滤镜。',
    binding: { command: 'setAnimation', name: 'oldFilm' }
  },
  {
    label: '点状滤镜',
    description: '套用点状滤镜。',
    binding: { command: 'setAnimation', name: 'dotFilm' }
  },
  {
    label: '反射滤镜',
    description: '套用反射滤镜。',
    binding: { command: 'setAnimation', name: 'reflectionFilm' }
  },
  {
    label: '故障滤镜',
    description: '套用故障滤镜。',
    binding: { command: 'setAnimation', name: 'glitchFilm' }
  },
  {
    label: 'RGB 分离',
    description: '套用 RGB 分离滤镜。',
    binding: { command: 'setAnimation', name: 'rgbFilm' }
  },
  {
    label: '光辉滤镜',
    description: '套用光辉滤镜。',
    binding: { command: 'setAnimation', name: 'godrayFilm' }
  },
  {
    label: '清除电影类滤镜',
    description: '只清除六个电影类滤镜。',
    binding: { command: 'setAnimation', name: 'removeFilm' }
  },
  {
    label: '冲击波入场',
    description: '冲击波入场效果。',
    binding: { command: 'setAnimation', name: 'shockwaveIn' }
  },
  {
    label: '冲击波退场',
    description: '冲击波退场效果。',
    binding: { command: 'setAnimation', name: 'shockwaveOut' }
  },
  {
    label: '雨',
    description: '持续舞台特效：雨。本次选择只绑定字段，不立即播放。',
    binding: { command: 'pixiPerform', name: 'rain' }
  },
  {
    label: '雪',
    description: '持续舞台特效：雪。本次选择只绑定字段，不立即播放。',
    binding: { command: 'pixiPerform', name: 'snow' }
  },
  {
    label: '大雪',
    description: '持续舞台特效：大雪。本次选择只绑定字段，不立即播放。',
    binding: { command: 'pixiPerform', name: 'heavySnow' }
  },
  {
    label: '樱花飘落',
    description: '持续舞台特效：樱花飘落。本次选择只绑定字段，不立即播放。',
    binding: { command: 'pixiPerform', name: 'cherryBlossoms' }
  }
]

export function presetOptionsFor(
  kind: SessionFieldKind
): readonly PresetOption<AnimationPresetBinding | EffectPresetBinding>[] {
  return kind === 'animation' ? ANIMATION_PRESET_OPTIONS : EFFECT_PRESET_OPTIONS
}

export function findAnimationPreset(
  name: string
): PresetOption<AnimationPresetBinding> | undefined {
  return ANIMATION_PRESET_OPTIONS.find((option) => option.binding.name === name)
}

export function findEffectPreset(name: string): PresetOption<EffectPresetBinding> | undefined {
  return EFFECT_PRESET_OPTIONS.find((option) => option.binding.name === name)
}

/** 按已保存绑定取出说明。找不到映射时不编造说明。 */
export function presetDescriptionOf(kind: SessionFieldKind, name: string): string | undefined {
  const option = kind === 'animation' ? findAnimationPreset(name) : findEffectPreset(name)
  return option?.description
}

/** 预设的中文名。未知绑定回落到命令名，不虚构名称。 */
export function presetLabelOf(kind: SessionFieldKind, name: string): string {
  const option = kind === 'animation' ? findAnimationPreset(name) : findEffectPreset(name)
  return option?.label ?? name
}
