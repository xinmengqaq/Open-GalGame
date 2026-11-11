import { describe, expect, it } from 'vitest'

import { ProjectErrorCodes } from '@domain/projects/errors/ProjectErrorCodes'
import { ConnectionErrorCodes } from '@domain/connections/errors/ConnectionErrorCodes'

const networkStatusCodes = [200, 400, 403, 409, 500]

describe('ProjectErrorCodes', () => {
  it('首页局部码不重复，不占用网络状态码，并按 11/12/13/14 分段', () => {
    expect(ProjectErrorCodes).toEqual({
      emptyName: 1101,
      nameTooLong: 1102,
      synopsisTooLong: 1103,
      invalidId: 1104,
      unsupportedPackageFormat: 1201,
      unsupportedFormatVersion: 1202,
      packageCorrupted: 1203,
      unsafePackagePath: 1204,
      alreadyRegistered: 1205,
      missingRequiredContent: 1206,
      invalidBusinessReference: 1207,
      packageChecksumFailed: 1208,
      notRegistered: 1209,
      destinationNotWritable: 1301,
      diskFull: 1302,
      destinationOccupied: 1303,
      storageFailed: 1304,
      publishFailed: 1305,
      registrationFailed: 1306,
      stagingCleanupFailed: 1307,
      selectedFileMissing: 1308,
      workspaceNotReady: 1309
    })

    const values = Object.values(ProjectErrorCodes)
    expect(new Set(values).size).toBe(values.length)
    expect(values.filter((code) => networkStatusCodes.includes(code))).toEqual([])
    expect(values.every((code) => Math.floor(code / 1000) === 1)).toBe(true)
    expect(
      [
        ProjectErrorCodes.emptyName,
        ProjectErrorCodes.nameTooLong,
        ProjectErrorCodes.synopsisTooLong,
        ProjectErrorCodes.invalidId
      ].map((code) => Math.floor(code / 100))
    ).toEqual([11, 11, 11, 11])
    expect(Math.floor(ProjectErrorCodes.alreadyRegistered / 100)).toBe(12)
    expect(Math.floor(ProjectErrorCodes.destinationNotWritable / 100)).toBe(13)
    expect(Math.floor(ConnectionErrorCodes.invalidConnectionConfig / 100)).toBe(14)
    expect(new Set([...values, ...Object.values(ConnectionErrorCodes)]).size).toBe(
      values.length + Object.values(ConnectionErrorCodes).length
    )
  })
})
