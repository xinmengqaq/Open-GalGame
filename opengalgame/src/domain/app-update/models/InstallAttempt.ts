import { compareAppVersion } from './AppVersion'

export type UpdateInstallAttempt = {
  fromVersion: string
  toVersion: string
  attemptedAt: string
}

export function didInstallAttemptFail(
  currentVersion: string,
  attempt: UpdateInstallAttempt
): boolean {
  if (currentVersion !== attempt.fromVersion) return false
  return compareAppVersion(currentVersion, attempt.toVersion) < 0
}
