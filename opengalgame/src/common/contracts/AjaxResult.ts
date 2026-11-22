export type AjaxResult<T = unknown> = {
  code: number
  msg: string
  reason?: string
  data?: T
}
