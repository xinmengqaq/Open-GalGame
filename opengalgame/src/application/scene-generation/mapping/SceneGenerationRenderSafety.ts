const FORBIDDEN_RENDER_FIELD: Record<string, true> = {
  filePath: true,
  relativePath: true,
  projectRoot: true,
  rootDirectory: true,
  sceneDirectory: true,
  workspace: true,
  entryFile: true,
  files: true,
  preview: true,
  differences: true,
  body: true,
  command: true,
  stack: true,
  cause: true,
  tool: true,
  tools: true,
  prompt: true,
  prompts: true
}

/** 渲染契约只允许稳定身份、数量、阶段、固定文案和累计 Token。 */
export function assertRenderContractSafe(value: unknown): void {
  const found = forbiddenRenderFields(value)
  if (found.length > 0) throw new Error(`渲染契约包含禁止字段: ${found.join(', ')}`)
}

export function forbiddenRenderFields(value: unknown): string[] {
  const found: string[] = []
  collectForbiddenFields(value, found)
  return found
}

function collectForbiddenFields(value: unknown, found: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectForbiddenFields(item, found)
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_RENDER_FIELD[key] && !found.includes(key)) found.push(key)
    collectForbiddenFields(nested, found)
  }
}
