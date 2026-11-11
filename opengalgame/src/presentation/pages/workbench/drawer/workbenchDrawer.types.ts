/** 作品历史写操作在途类型；抽屉据此拒绝关闭抽屉和关闭作品历史标签。 */
export type WorkbenchDrawerBusy = 'undo' | 'clear' | null

/**
 * 浏览器式标签栏的公开类型；抽屉壳只从这里取标签身份、状态和角标形状，
 * 不复制生成、候选或历史的业务 DTO/VO。
 */
export type { DrawerTabBadge, DrawerTabId, DrawerTabsState, DrawerTabTone } from './drawerTabs'
