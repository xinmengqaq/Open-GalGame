import { describe, expect, it } from 'vitest'

import { webgalBoolean } from '@infrastructure/webgal/compatibility/WebgalCommandArguments'

describe('webgalBoolean', () => {
  it('按引擎对大小写和空白归一，动态变量不提前判定', () => {
    expect(webgalBoolean(true)).toBe(true)
    expect(webgalBoolean(false)).toBe(false)
    expect(webgalBoolean(' TRUE ')).toBe(true)
    expect(webgalBoolean('FALSE')).toBe(false)
    expect(webgalBoolean(' false ')).toBe(false)
    expect(webgalBoolean('{flag}')).toBeUndefined()
    expect(webgalBoolean('prefix{flag}')).toBeUndefined()
    expect(webgalBoolean(1)).toBe(true)
    expect(webgalBoolean(0)).toBe(false)
    expect(webgalBoolean(undefined)).toBeUndefined()
  })
})
