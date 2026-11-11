interface AgentRunProjections {
  output: Promise<unknown>
  toolCalls: AsyncIterable<{ output: Promise<unknown> }>
  subagents: AsyncIterable<AgentRunProjections>
}

/** 消费同一次 v3 调用的嵌套投影并接住结果拒绝，原始失败仍由根输出传播。 */
export async function settleAgentRunProjections(run: AgentRunProjections): Promise<void> {
  void run.output.catch(() => {})
  const tools = (async (): Promise<void> => {
    for await (const call of run.toolCalls) void call.output.catch(() => {})
  })()
  const nested = (async (): Promise<void> => {
    const completions: Promise<void>[] = []
    for await (const child of run.subagents) completions.push(settleAgentRunProjections(child))
    await Promise.allSettled(completions)
  })()
  await Promise.allSettled([tools, nested])
}
