import { describe, expect, it } from 'vitest'

import {
  didInstallAttemptFail,
  type UpdateInstallAttempt
} from '@domain/app-update/models/InstallAttempt'

function attempt(fromVersion: string, toVersion: string): UpdateInstallAttempt {
  return {
    fromVersion,
    toVersion,
    attemptedAt: '2026-11-12T03:04:05.000Z'
  }
}

describe('更新安装尝试核对', () => {
  it('当前版本仍是安装前版本且目标更高时判定上次安装失败', () => {
    expect(didInstallAttemptFail('0.1.0', attempt('0.1.0', '0.1.1'))).toBe(true)
    expect(didInstallAttemptFail('0.1.9', attempt('0.1.9', '0.1.10'))).toBe(true)
  })

  it('已经达到目标版本时不报失败', () => {
    expect(didInstallAttemptFail('0.1.1', attempt('0.1.0', '0.1.1'))).toBe(false)
  })

  it('已经超过目标版本或其他版本时不报失败', () => {
    expect(didInstallAttemptFail('0.2.0', attempt('0.1.0', '0.1.1'))).toBe(false)
    expect(didInstallAttemptFail('0.0.9', attempt('0.1.0', '0.1.1'))).toBe(false)
  })

  it('目标与安装前版本相同时不报失败', () => {
    expect(didInstallAttemptFail('0.1.0', attempt('0.1.0', '0.1.0'))).toBe(false)
  })

  it('记录版本格式非法时明确抛出，不静默当作成功', () => {
    expect(() => didInstallAttemptFail('0.1.0', attempt('0.1.0', '0.1'))).toThrow()
  })
})
