import type { ProjectListEntryVO } from '@application/projects/vo/ProjectVO'

export type FixtureMode = 'mixed' | 'empty' | 'fail'

const availableProjects: ReadonlyArray<readonly [string, string, string]> = [
  ['p-01', '未寄出的第二封信', '选项写在信封内侧，拆开之前谁都不知道下一句。'],
  ['p-02', '便利店打烊之后', '冷柜灯还亮着，货架上的角色还在等你开口。'],
  ['p-03', '只有一次的彩排', '台词对了，路线却分叉了。'],
  ['p-04', '窗边的存档点', ''],
  [
    'p-05',
    '把一句心动写成可以选的那堂课',
    '作业没有标准答案。你写下的每一句，都会变成别人要走的路。这一行用来确认三行截断仍然稳住网格。'
  ],
  ['p-06', '灯还亮着的站台', '末班车开走以后，站牌上的字开始替你说话。'],
  ['p-07', '雨停之前的三分钟', '伞只有一把，选项却有两条。'],
  ['p-08', '没有观众的彩排厅', '你把第一句台词说给空座位听。'],
  ['p-09', '第三次按下开始', '存档点还在，角色已经换了一张脸。'],
  ['p-10', '空白页上的第一行', '从这里写下可以玩的故事。']
]

const unavailableProject: ProjectListEntryVO = {
  status: 'unavailable',
  id: 'p-unavailable',
  code: 1206,
  msg: '登记的项目内容缺失，无法读取'
}

/**
 * @returns 未指定或无法识别时按混排场景。
 */
export function readFixtureMode(): FixtureMode {
  const value = new URLSearchParams(window.location.search).get('projects')
  return value === 'empty' || value === 'fail' ? value : 'mixed'
}

/**
 * 建立夹具条目索引，按登记标识直接查找与增删。
 * @returns 空场景为空表，其余为十条可读条目与一条不可用条目。
 */
export function createProjectFixtureStore(): Map<string, ProjectListEntryVO> {
  if (readFixtureMode() === 'empty') return new Map()
  const entries: ProjectListEntryVO[] = [
    ...availableProjects.map(([id, name, synopsis]) => ({
      status: 'available' as const,
      id,
      name,
      synopsis
    })),
    unavailableProject
  ]
  return new Map(entries.map((entry): [string, ProjectListEntryVO] => [entry.id, entry]))
}
