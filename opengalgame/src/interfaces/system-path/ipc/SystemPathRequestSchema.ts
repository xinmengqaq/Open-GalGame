import { z } from 'zod'

/** 只接受一个本机路径；绝对路径与目录校验在服务端完成。 */
export const openDirectorySchema = z.strictObject({
  path: z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .refine((value) => !value.includes('\u0000'))
})
