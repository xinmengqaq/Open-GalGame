export const ErrorCodes = {
  success: 2000,
  invalidRequest: 4101,
  forbidden: 4102,
  operationConflict: 4103,
  invalidConfig: 5101,
  communicationFailed: 5102,
  internalError: 5103
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

type FailureCode = Exclude<ErrorCode, typeof ErrorCodes.success>

export const errorMessages: Record<FailureCode, string> = {
  [ErrorCodes.invalidRequest]: '请求参数格式不正确',
  [ErrorCodes.forbidden]: '请求来源或资源访问未获授权',
  [ErrorCodes.operationConflict]: '同一操作标识对应的请求内容不一致',
  [ErrorCodes.invalidConfig]: '应用配置无效',
  [ErrorCodes.communicationFailed]: '与主进程通信失败，操作结果待确认',
  [ErrorCodes.internalError]: '系统异常，操作未完成'
}
