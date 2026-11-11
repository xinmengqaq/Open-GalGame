import { describe, expect, it } from 'vitest'

import { resolveSceneParserConstructor } from '@infrastructure/scenes/SceneScriptParserGatewayImpl'

function parserConstructor(): new () => object {
  return class SceneParser {}
}

describe('resolveSceneParserConstructor', () => {
  it('构造器本身和带 default 的模块形状都返回同一构造器', () => {
    const constructor = parserConstructor()

    expect(resolveSceneParserConstructor(constructor)).toBe(constructor)
    expect(resolveSceneParserConstructor({ default: constructor })).toBe(constructor)
  })
})
