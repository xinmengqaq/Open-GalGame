/**
 * 交给系统打开的目录。
 * 只带一个路径；服务端会校验它是已存在的本机绝对目录后交给系统打开，不执行任意命令。
 */
export type OpenDirectoryDTO = {
  readonly path: string
}
