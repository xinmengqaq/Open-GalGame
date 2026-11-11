import type { SceneArgumentValue } from '@application/scenes/models/ParsedScene'

type ArgumentKind = 'boolean' | 'number' | 'string'
type ArgumentProfile = Readonly<Record<string, ArgumentKind>>

const positions: ArgumentProfile = {
  center: 'boolean',
  left: 'boolean',
  right: 'boolean',
  left13: 'boolean',
  right13: 'boolean',
  left14: 'boolean',
  right14: 'boolean'
}
const associatedFigures: ArgumentProfile = {
  mouthOpen: 'string',
  mouthClose: 'string',
  mouthHalfOpen: 'string',
  eyesOpen: 'string',
  eyesClose: 'string',
  animationFlag: 'string'
}
const animationArguments: ArgumentProfile = {
  target: 'string',
  keep: 'boolean',
  parallel: 'boolean',
  transformFrom: 'string',
  writeDefault: 'boolean',
  ignoreDefault: 'boolean'
}
const transitionArguments: ArgumentProfile = {
  enter: 'string',
  exit: 'string',
  duration: 'number',
  ease: 'string',
  transform: 'string',
  enterDuration: 'number',
  exitDuration: 'number',
  ignoreDefault: 'boolean'
}

export const WEBGAL_COMMON_ARGUMENTS: ArgumentProfile = {
  next: 'boolean',
  continue: 'boolean',
  when: 'string'
}

export const WEBGAL_UNSUPPORTED_COMMANDS = ['if', 'chooseLabel'] as const

export const WEBGAL_COMMAND_ARGUMENTS: Readonly<Record<string, ArgumentProfile>> = {
  say: {
    ...positions,
    speaker: 'string',
    vocal: 'string',
    volume: 'number',
    concat: 'boolean',
    notend: 'boolean',
    clear: 'boolean',
    fontSize: 'string',
    figureId: 'string'
  },
  changeBg: { ...transitionArguments, unlockname: 'string', series: 'string', order: 'number' },
  changeFigure: {
    ...positions,
    ...associatedFigures,
    ...transitionArguments,
    id: 'string',
    clear: 'boolean',
    motion: 'string',
    skin: 'string',
    expression: 'string',
    bounds: 'string',
    blink: 'string',
    focus: 'string',
    zIndex: 'number',
    blendMode: 'string'
  },
  changeFigureDiff: { ...positions, ...associatedFigures, id: 'string' },
  miniAvatar: {},
  bgm: { volume: 'number', enter: 'number', unlockname: 'string', series: 'string' },
  playEffect: { volume: 'number', id: 'string' },
  playVideo: { skipOff: 'boolean' },
  wait: { nobreak: 'boolean' },
  intro: {
    fontSize: 'string',
    backgroundImage: 'string',
    backgroundColor: 'string',
    fontColor: 'string',
    animation: 'string',
    delayTime: 'number',
    hold: 'boolean',
    userForward: 'boolean'
  },
  setVar: { global: 'boolean', local: 'boolean' },
  label: {},
  jumpLabel: {},
  choose: { defaultChoose: 'number' },
  changeScene: {},
  return: {},
  end: {},
  unlockCg: { name: 'string', series: 'string', order: 'number' },
  unlockBgm: { name: 'string', series: 'string' },
  setTransform: { ...animationArguments, duration: 'number', ease: 'string' },
  setAnimation: animationArguments,
  setTempAnimation: animationArguments,
  setComplexAnimation: { duration: 'number', target: 'string' },
  setTransition: { target: 'string', enter: 'string', exit: 'string', ignoreDefault: 'boolean' },
  setFilter: {},
  filmMode: {},
  setTextbox: {},
  applyStyle: {},
  getUserInput: {
    title: 'string',
    buttonText: 'string',
    defaultValue: 'string',
    rule: 'string',
    ruleFlag: 'string',
    ruleText: 'string',
    ruleButtonText: 'string'
  },
  callSteam: { achievementId: 'string' },
  pixiPerform: {},
  pixiInit: {},
  showVars: {}
}

/**
 * 按 WebGAL 引擎的布尔读取转换参数值。
 * 字符串先去掉首尾空白并转小写；只有 true 和 false 得到布尔，动态变量和其他文本留到运行时判断。
 * @param value - 解析后的参数值。缺失时为 undefined。
 * @returns 引擎确定的布尔；无法静态判定时为 undefined。
 */
export function webgalBoolean(value: SceneArgumentValue | null | undefined): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
    return undefined
  }
  if (typeof value === 'number') return value !== 0
  return undefined
}

/** 核对字面值类型；引擎会先插值的未转义占位保留至运行时判断。 */
export function isWebgalArgumentValueSupported(
  value: SceneArgumentValue,
  kind: ArgumentKind
): boolean {
  if (kind === 'string') return true
  if (typeof value === 'string' && /(?<!\\)\{(.*?)\}/u.test(value)) return true
  if (kind === 'number')
    return !Number.isNaN(Number(typeof value === 'string' ? value.trim() : value))
  return typeof value !== 'string' || ['true', 'false'].includes(value.trim().toLowerCase())
}
