import { randomUUID } from 'node:crypto'

/** 返回本地 SSE 模型替身，完成模型、echo 工具、模型；不发网络请求。 */
export const studioMockFetch: typeof fetch = async (_url, init) => {
  const request = JSON.parse(String(init?.body)) as {
    messages: Array<{ role: string }>
    stream?: boolean
  }
  const finished = request.messages.at(-1)?.role === 'tool'
  const id = randomUUID()
  const message = finished
    ? { role: 'assistant', content: '本地调试完成' }
    : {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'studio-echo',
            type: 'function',
            function: { name: 'echo', arguments: JSON.stringify({ text: '本地工具调用' }) }
          }
        ]
      }
  if (!request.stream)
    return Response.json({
      id,
      model: 'studio-mock',
      choices: [{ index: 0, message, finish_reason: finished ? 'stop' : 'tool_calls' }]
    })
  const delta = finished
    ? { role: 'assistant', content: '本地调试完成' }
    : { ...message, tool_calls: message.tool_calls?.map((call) => ({ ...call, index: 0 })) }
  const chunks = [
    {
      id,
      object: 'chat.completion.chunk',
      model: 'studio-mock',
      choices: [{ index: 0, delta, finish_reason: null }]
    },
    {
      id,
      object: 'chat.completion.chunk',
      model: 'studio-mock',
      choices: [{ index: 0, delta: {}, finish_reason: finished ? 'stop' : 'tool_calls' }]
    },
    {
      id,
      object: 'chat.completion.chunk',
      model: 'studio-mock',
      choices: [],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
    }
  ]
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } }
  )
}
