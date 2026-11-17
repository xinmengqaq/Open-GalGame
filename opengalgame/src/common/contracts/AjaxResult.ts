export type AjaxResult<T = unknown> = {
  code: number
  msg: string
  /**
   * 失败专属的结构化原因，成功响应不携带；由失败结果 schema 校验。
   * 不是通用错误模型，只有需要跨进程判别的少数业务才有值。
   */
  reason?: string
  data?: T
}
