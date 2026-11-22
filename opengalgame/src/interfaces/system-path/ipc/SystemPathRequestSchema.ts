import { z } from 'zod'

export const openDirectorySchema = z.strictObject({
  path: z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .refine((value) => !value.includes('\u0000'))
})
