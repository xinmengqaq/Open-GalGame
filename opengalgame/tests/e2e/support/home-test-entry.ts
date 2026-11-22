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

window.homeTest = { gsap, navigation: useNavigationStore }
