/** 产物的归属标记；同名目录只有带匹配标记才允许复用或替换。 */
export const EXPORT_MARKER_FILE = '.scene-export.json'

/** 与目标父目录同卷的临时组装目录前缀；发布时整体 rename。 */
export const EXPORT_STAGING_PREFIX = '.scene-export-staging-'

/** 替换本场景旧产物时的备份前缀；只用于本场景已归属目录。 */
export const EXPORT_BACKUP_PREFIX = '.scene-export-replaced-'
