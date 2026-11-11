import { create } from 'zustand'

export type AppPage = 'home' | 'projects' | 'workbench'

type OpenedProject = { id: string; name: string }

interface NavigationState {
  page: AppPage
  openedProject: OpenedProject | null
  hasPlayedHomeIntro: boolean
  visit: (page: AppPage) => void
  openWorkbench: (project: OpenedProject) => void
  markHomeIntroPlayed: () => void
}

/** 跨页面导航、当前打开作品与入场是否已播放。 */
export const useNavigationStore = create<NavigationState>((set) => ({
  page: 'home',
  openedProject: null,
  hasPlayedHomeIntro: false,
  /** 切换到指定页面；离开工作区时清空已打开作品。 */
  visit: (page) =>
    set((state) => ({
      page,
      openedProject: page === 'workbench' ? state.openedProject : null
    })),
  openWorkbench: (project) => set({ page: 'workbench', openedProject: project }),
  /** 标记首页入场已播放，返回首页不再重播。 */
  markHomeIntroPlayed: () => set({ hasPlayedHomeIntro: true })
}))
