import { DEFAULT_GAME_CONFIG, DEFAULT_USER_STYLE_SHEET } from './defaultWebgalAssets'

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

export function defaultRuntimeAssetFor(pathname: string): DefaultRuntimeAsset | undefined {
  return defaultRuntimeAssets.get(pathname)
}
