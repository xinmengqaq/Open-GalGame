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

export const useNavigationStore = create<NavigationState>((set) => ({
  page: 'home',
  openedProject: null,
  hasPlayedHomeIntro: false,
  visit: (page) =>
    set((state) => ({
      page,
      openedProject: page === 'workbench' ? state.openedProject : null
    })),
  openWorkbench: (project) => set({ page: 'workbench', openedProject: project }),
  markHomeIntroPlayed: () => set({ hasPlayedHomeIntro: true })
}))
