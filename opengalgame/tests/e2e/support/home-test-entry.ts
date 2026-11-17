import '@bootstrap/renderer'
import gsap from 'gsap'

import { useNavigationStore } from '@presentation/stores/navigation.store'

declare global {
  interface Window {
    homeTest: {
      gsap: typeof gsap
      navigation: typeof useNavigationStore
    }
  }
}

// 与真实 renderer 共用同一份模块实例：用例可检查入场动画与导航状态。
window.homeTest = { gsap, navigation: useNavigationStore }
