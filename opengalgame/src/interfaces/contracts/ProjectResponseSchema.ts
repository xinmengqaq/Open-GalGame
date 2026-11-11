import { z } from 'zod'

import { ErrorCodes } from '@common/errors/ErrorCodes'

const projectSummaryShape = {
  id: z.string(),
  name: z.string(),
  synopsis: z.string()
}

/** 判别列表项：可读项带摘要，不可读项带安全错误码。 */
const projectListEntrySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), ...projectSummaryShape }),
  z.object({ status: z.literal('unavailable'), id: z.string(), code: z.number(), msg: z.string() })
])

/** 成功响应给出完整一页。失败响应只有错误码和消息，键缺失也算没有 data。 */
const projectListResultSchema = z.union([
  z.object({
    code: z.literal(ErrorCodes.success),
    msg: z.string(),
    data: z.object({
      entries: z.array(projectListEntrySchema),
      total: z.number(),
      offset: z.number(),
      limit: z.number()
    })
  }),
  z.strictObject({
    code: z.number().refine((code) => code !== ErrorCodes.success),
    msg: z.string()
  })
])

/** 判断未知值是不是项目列表分页响应。只判定形状，不复制取值。 */
export function isProjectListResult(value: unknown): boolean {
  return projectListResultSchema.safeParse(value).success
}
