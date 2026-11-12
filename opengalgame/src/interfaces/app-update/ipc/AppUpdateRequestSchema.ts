import { z } from 'zod'

/** 检查更新只区分用户主动与启动后台，不接受发布源、版本或安装参数。 */
export const checkForUpdateSchema = z.strictObject({
  reason: z.enum(['manual', 'background'])
})

/** 下载与安装只接受空对象；多出的地址、目录或参数一律拒绝。 */
export const emptyUpdateRequestSchema = z.strictObject({})
