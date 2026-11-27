import { describe, expect, it } from 'vitest'

import { FONT_PRESET_OPTIONS } from '@application/settings/appearance/models/FontPresetCatalog'
import { appearanceFontPresetIds } from '@domain/settings/appearance/models/AppearanceSettings'

const systemFontFallback =
  'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif'

const expectedCatalog: {
  id: string
  label: string
  family: string
  roles: readonly ('body' | 'dialogue' | 'title' | 'mono')[]
}[] = [
  { id: 'system', label: '系统字体', family: 'system-ui', roles: ['body', 'dialogue', 'title'] },
  { id: 'source-han-sans', label: '思源黑体', family: 'Noto Sans SC', roles: ['body'] },
  { id: 'source-han-serif', label: '思源宋体', family: 'Noto Serif SC', roles: ['dialogue'] },
  {
    id: 'lxgw-wenkai-gb',
    label: '霞鹜文楷 GB',
    family: 'LXGW WenKai GB',
    roles: ['dialogue']
  },
  { id: 'smiley-sans', label: '得意黑', family: 'Smiley Sans', roles: ['title'] }
]

describe('字体选项目录', () => {
  it('按领域标识顺序穷举五项元数据', () => {
    expect(FONT_PRESET_OPTIONS).toEqual(
      expectedCatalog.map((option) => ({
        ...option,
        fallback: systemFontFallback,
        bundled: true
      }))
    )
    expect(FONT_PRESET_OPTIONS.map((option) => option.id)).toEqual([...appearanceFontPresetIds])
  })

  it('全部预设声明随包内置', () => {
    for (const option of FONT_PRESET_OPTIONS) expect(option.bundled).toBe(true)
  })

  it('系统字体使用系统栈并标记正文、对白和标题用途', () => {
    expect(FONT_PRESET_OPTIONS[0]).toEqual({
      id: 'system',
      label: '系统字体',
      family: 'system-ui',
      fallback: systemFontFallback,
      bundled: true,
      roles: ['body', 'dialogue', 'title']
    })
  })
})
