export const ConnectionErrorCodes = {
  invalidConnectionConfig: 1401,
  invalidApiKey: 1402,
  modelUnavailable: 1403,
  connectionTimeout: 1404,
  cannotReachModel: 1405,
  rateLimited: 1406,
  modelServiceError: 1407,
  credentialStoreFailed: 1408,
  settingsSaveFailed: 1409
} as const

export type ConnectionErrorCode = (typeof ConnectionErrorCodes)[keyof typeof ConnectionErrorCodes]
