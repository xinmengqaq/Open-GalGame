import { z } from 'zod'

export const checkForUpdateSchema = z.strictObject({
  reason: z.enum(['manual', 'background'])
})

export const emptyUpdateRequestSchema = z.strictObject({})
