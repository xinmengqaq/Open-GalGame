import type { ReactElement, Ref } from 'react'

import hero from '../../assets/home-hero-character.webp'
import styles from './HomePage.module.css'

interface HomeVisualProps {
  visualRef: Ref<HTMLDivElement>
  heroRef: Ref<HTMLImageElement>
  circleRef: Ref<HTMLDivElement>
  speechRef: Ref<HTMLDivElement>
}

export function HomeVisual({
  visualRef,
  heroRef,
  circleRef,
  speechRef
}: HomeVisualProps): ReactElement {
  return (
    <div className={styles.visual} ref={visualRef} aria-hidden="true">
      <div className={styles.circle} ref={circleRef} data-parallax="circle" />
      <svg className={`${styles.star} ${styles.starA}`} data-parallax="star-a" viewBox="0 0 24 24">
        <path d="M12 2.5 13.8 9h6.7l-5.4 4 2 6.5L12 16.2 6.9 19.5l2-6.5L3.5 9h6.7Z" />
      </svg>
      <svg className={`${styles.star} ${styles.starB}`} data-parallax="star-b" viewBox="0 0 24 24">
        <path d="M12 3 13 9l6 .5-5 3.5 2 6L12 16l-4 3 2-6-5-3.5L11 9Z" />
      </svg>
      <img ref={heroRef} className={styles.hero} src={hero} alt="" data-motion="hero" />
      <div className={styles.speech} ref={speechRef} data-motion="speech">
        「下一句，你来写。」
      </div>
    </div>
  )
}
