/** 把既有完成响应转换为真实 SSE 分块；非流式请求和错误响应保持原协议。 */
export function streamingFetch(fetcher: typeof fetch): typeof fetch {
  return async (url, init) => {
    const response = await fetcher(url, init)
    const request = JSON.parse(String(init?.body)) as { stream?: boolean }
    if (!request.stream || !response.ok || !response.headers.get('content-type')?.includes('json'))
      return response
    const completion = await response.json()
    const chunks: unknown[] = []
    for (const choice of completion.choices) {
      const message = choice.message
      const base = {
        id: completion.id,
        object: 'chat.completion.chunk',
        created: 1,
        model: completion.model
      }
      chunks.push({
        ...base,
        choices: [{ index: choice.index, delta: { role: 'assistant' }, finish_reason: null }]
      })
      if (message.content) {
        for (const text of message.content.match(/.{1,2}/gs) ?? [])
          chunks.push({
            ...base,
            choices: [{ index: choice.index, delta: { content: text }, finish_reason: null }]
          })
      }
      if (message.tool_calls)
        chunks.push({
          ...base,
          choices: [
            {
              index: choice.index,
              delta: { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) },
              finish_reason: null
            }
          ]
        })
      chunks.push({
        ...base,
        choices: [{ index: choice.index, delta: {}, finish_reason: choice.finish_reason }]
      })
    }
    if (completion.usage)
      chunks.push({
        id: completion.id,
        object: 'chat.completion.chunk',
        model: completion.model,
        choices: [],
        usage: completion.usage
      })
    const encoded =
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(encoded, { headers: { 'content-type': 'text/event-stream' } })
  }
}
