export const ProjectErrorCodes = {
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
} as const

export type ProjectErrorCode = (typeof ProjectErrorCodes)[keyof typeof ProjectErrorCodes]
