export type Response<T = unknown> = {
  code: number
  msg: string
  data?: T
}
