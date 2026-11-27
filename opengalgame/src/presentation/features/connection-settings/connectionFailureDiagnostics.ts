/**
 * 连接失败的安全分类。只接受网关已定义的固定 token，避免把上游原文
 * 或任意字符串带进界面；未识别的 reason 不回显，只退回错误码分类。
 */

const providerHttpStatus = /^providerHttpStatus(\d{3})$/

const fixedReasonLabels: Readonly<Record<string, string>> = {
  providerFinishReasonContentFilter: '输出被内容安全策略拦截',
  providerFinishReasonNetworkError: '上游网络中断',
  providerFinishReason: '上游以非正常原因结束生成',
  streamWithoutFinishReason: '流式响应缺少完成标记',
  providerRefusal: '模型拒绝完成请求',
  providerContentFlagged: '输出被标记为敏感内容',
  providerUnknownStopReason: '上游返回未知停止原因',
  providerError: '上游返回未分类错误',
  invalidProviderResponse: '响应格式无法识别'
}

const codeLabels: Readonly<Record<number, string>> = {
  1402: '认证未通过',
  1403: '模型或接口不可用',
  1404: '请求超时',
  1405: '无法连接模型服务',
  1406: '请求频率受限',
  1407: '上游响应未通过校验',
  1409: '设置未能保存'
}

function httpStatusLabel(status: number): string {
  if (status === 400) return '上游拒绝了测试请求'
  if (status === 401) return '上游鉴权未通过'
  if (status === 403) return '上游拒绝访问'
  if (status === 404) return '上游找不到模型或接口'
  if (status === 408) return '上游请求超时'
  if (status === 409) return '上游状态冲突'
  if (status === 413) return '请求内容过大'
  if (status === 422) return '请求参数未通过上游校验'
  if (status === 429) return '请求过于频繁'
  if (status >= 500 && status <= 599) return '上游服务异常'
  return `上游返回 HTTP ${status}`
}

export interface ConnectionFailureDiagnostic {
  /** 只含可展示的安全分类。 */
  label: string
  /** 允许展示和写入 data-reason 的固定 token。 */
  reason: string | null
}

export function connectionFailureDiagnostic(
  code: number,
  reason: string | undefined
): ConnectionFailureDiagnostic {
  if (reason !== undefined) {
    const http = providerHttpStatus.exec(reason)
    if (http) {
      const status = Number(http[1])
      return { label: httpStatusLabel(status), reason }
    }
    const fixed = fixedReasonLabels[reason]
    if (fixed !== undefined) return { label: fixed, reason }
  }
  return {
    label: codeLabels[code] ?? '未分类的连接错误',
    reason: null
  }
}

export function connectionFailureDiagnosticText(code: number, reason: string | undefined): string {
  return `分类：${connectionFailureDiagnostic(code, reason).label}`
}

/**
 * 只给可安全归类且用户能自行处理的失败补排查方向；不读取或回显扩展配置、
 * 请求头、上游原文或内部错误码。
 */
export function connectionFailureActionHint(
  code: number,
  reason: string | undefined
): string | null {
  if (code === 1407 && reason === 'providerHttpStatus400') {
    return '按供应商要求检查扩展 JSON 的 defaultHeaders、模型和请求参数。'
  }
  switch (code) {
    case 1402:
      return '检查 API Key 与账号权限后重新测试。'
    case 1403:
      return '检查模型名和接口路径后重新测试。'
    case 1404:
      return '检查上游地址和网络后重新测试。'
    case 1405:
      return '检查上游地址、端口和模型服务是否已启动后重新测试。'
    case 1406:
      return '稍后重新测试，或检查供应商的调用频率与配额。'
    case 1407:
      return '检查请求参数与扩展配置后重新测试。'
    case 1409:
      return '重新保存；仍然失败时重新读取设置再试。'
    default:
      return null
  }
}
