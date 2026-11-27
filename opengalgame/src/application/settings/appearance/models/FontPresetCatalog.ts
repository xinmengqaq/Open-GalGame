import {
  appearanceFontPresetIds,
  type AppearanceFontPresetId
} from '@domain/settings/appearance/models/AppearanceSettings'

import type { FontPresetOptionVO } from '../vo/AppearanceSettingsVO'

const systemFontFallback =
  'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif'

type FontPresetMetadata = Pick<FontPresetOptionVO, 'label' | 'family' | 'roles'>

const fontPresetMetadata: Record<AppearanceFontPresetId, FontPresetMetadata> = {
  system: {
    label: '系统字体',
    family: 'system-ui',
    roles: ['body', 'dialogue', 'title']
  },
  'source-han-sans': {
    label: '思源黑体',
    family: 'Noto Sans SC',
    roles: ['body']
  },
  'source-han-serif': {
    label: '思源宋体',
    family: 'Noto Serif SC',
    roles: ['dialogue']
  },
  'lxgw-wenkai-gb': {
    label: '霞鹜文楷 GB',
    family: 'LXGW WenKai GB',
    roles: ['dialogue']
  },
  'smiley-sans': {
    label: '得意黑',
    family: 'Smiley Sans',
    roles: ['title']
  }
}

export const FONT_PRESET_OPTIONS: readonly FontPresetOptionVO[] = appearanceFontPresetIds.map(
  (id) => ({
    id,
    ...fontPresetMetadata[id],
    fallback: systemFontFallback,
    bundled: true
  })
)
