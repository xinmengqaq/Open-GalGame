import { createHash } from 'node:crypto'

/** 授权正文的虚拟读取目录；只存在于输入快照，不写入候选工作区或修订。 */
const authorizedInputRoot = '.opengalgame/authorized-inputs'

/**
 * 把画布文档/提示词身份映射为稳定的虚拟读取路径。
 * 文件名只含身份摘要，避免作者文字进入路径；同一身份每轮得到同一路径。
 * 路径对应的正文由当前不可变输入快照在内存中提供，不落盘。
 */
export function authorizedInputReadPath(
  kind: 'documents' | 'prompts',
  id: string
): string {
  const digest = createHash('sha256').update(id).digest('hex').slice(0, 16)
  return `${authorizedInputRoot}/${kind}/${digest}.md`
}
