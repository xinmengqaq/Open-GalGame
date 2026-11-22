export const SystemPathErrorCodes = {
  pathRejected: 4701,
  openFailed: 4702
} as const

export type SystemPathErrorCode = (typeof SystemPathErrorCodes)[keyof typeof SystemPathErrorCodes]

export const systemPathErrorMessages: Record<SystemPathErrorCode, string> = {
  [SystemPathErrorCodes.pathRejected]: '只能打开本机已有的目录',
  [SystemPathErrorCodes.openFailed]: '系统无法打开该目录'
}
