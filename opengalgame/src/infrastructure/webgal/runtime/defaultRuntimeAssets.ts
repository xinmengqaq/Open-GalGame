import { DEFAULT_GAME_CONFIG, DEFAULT_USER_STYLE_SHEET } from './defaultWebgalAssets'

/**
 * 引擎启动时固定请求、但预览工程不一定写入的可选 `game/` 文件的默认内容。
 * 文本来自 `defaultWebgalAssets.ts`，与导出链写入的默认文件是同一份来源：
 * - `config.txt` 对应导出链写入的单场景配置；
 * - `userStyleSheet.css` 对应导出链写入的黑色 letterbox 样式；
 * - `template/template.json` 为空对象，`animation/animationTable.json` 必须是数组：
 *   引擎用 `for...of` 遍历动画表里的文件名，对象字面量会抛 `not iterable`。
 * 只按精确路径命中；其他缺失的 `game/*` 仍按 404 处理，避免掩盖真实缺文件。
 */
export interface DefaultRuntimeAsset {
  readonly body: string
  readonly contentType: string
}

const defaultRuntimeAssets: ReadonlyMap<string, DefaultRuntimeAsset> = new Map([
  ['game/config.txt', { body: DEFAULT_GAME_CONFIG, contentType: 'text/plain; charset=utf-8' }],
  [
    'game/userStyleSheet.css',
    { body: DEFAULT_USER_STYLE_SHEET, contentType: 'text/css; charset=utf-8' }
  ],
  ['game/template/template.json', { body: '{}', contentType: 'application/json; charset=utf-8' }],
  [
    'game/animation/animationTable.json',
    { body: '[]', contentType: 'application/json; charset=utf-8' }
  ]
])

/**
 * @param pathname - 已解码、去掉前导斜杠的请求路径。
 * @returns 精确命中时的默认资源；未命中时为 undefined。
 */
export function defaultRuntimeAssetFor(pathname: string): DefaultRuntimeAsset | undefined {
  return defaultRuntimeAssets.get(pathname)
}
