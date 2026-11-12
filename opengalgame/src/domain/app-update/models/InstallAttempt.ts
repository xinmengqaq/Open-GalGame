import { compareAppVersion } from './AppVersion'

/** 一次已启动的更新安装。用于下一次启动核对安装是否实际完成。 */
export type UpdateInstallAttempt = {
  fromVersion: string
  toVersion: string
  attemptedAt: string
}

/**
 * 启动时判断上次安装尝试是否失败。
 * 只有当前版本仍是安装前版本、且目标版本尚未达到时才提示失败；已升级、已超过目标或已是其他版本都不报失败。
 * 版本必须已按应用版本规则校验。
 * @throws {InvalidAppVersionError} 记录中的版本格式非法。
 */
export function didInstallAttemptFail(
  currentVersion: string,
  attempt: UpdateInstallAttempt
): boolean {
  if (currentVersion !== attempt.fromVersion) return false
  return compareAppVersion(currentVersion, attempt.toVersion) < 0
}
