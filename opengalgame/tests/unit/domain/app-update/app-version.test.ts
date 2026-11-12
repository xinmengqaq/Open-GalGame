import { describe, expect, it } from 'vitest'

import { compareAppVersion, InvalidAppVersionError } from '@domain/app-update/models/AppVersion'

describe('应用版本比较', () => {
  it('按数值逐段比较三段版本', () => {
    expect(compareAppVersion('0.1.9', '0.1.10')).toBe(-1)
    expect(compareAppVersion('0.1.10', '0.1.9')).toBe(1)
    expect(compareAppVersion('1.2.3', '1.2.3')).toBe(0)
    expect(compareAppVersion('2.0.0', '1.99.99')).toBe(1)
    expect(compareAppVersion('0.2.0', '0.10.0')).toBe(-1)
  })

  it('超出安全整数范围的段仍按十进制位数比较', () => {
    expect(compareAppVersion('9007199254740993.0.0', '9007199254740992.0.0')).toBe(1)
    expect(compareAppVersion('1000000000000000000000.0.0', '999999999999999999999.0.0')).toBe(1)
  })

  it.each([
    '',
    '1',
    '1.2',
    '1.2.3.4',
    'v1.2.3',
    '1.2.3-beta',
    '1.2.3+build',
    '1.2.-1',
    ' 1.2.3',
    '1.2.3 '
  ])('拒绝非三段非负整数版本 %j', (version) => {
    expect(() => compareAppVersion('1.0.0', version)).toThrow(InvalidAppVersionError)
    expect(() => compareAppVersion(version, '1.0.0')).toThrow(InvalidAppVersionError)
  })
})
