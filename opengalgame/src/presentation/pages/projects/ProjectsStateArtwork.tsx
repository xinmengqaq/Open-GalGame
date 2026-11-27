import { useId, type ReactElement } from 'react'

import styles from './ProjectsPage.module.css'

function ArtDefs({ uid }: { uid: string }): ReactElement {
  return (
    <defs>
      <linearGradient id={`${uid}-sky`} x1="0" y1="0" x2="0.18" y2="1">
        <stop offset="0" stopColor="var(--pg-art-sky-top)" />
        <stop offset="0.54" stopColor="var(--pg-art-sky-mid)" />
        <stop offset="1" stopColor="var(--pg-art-sky-low)" />
      </linearGradient>
      <radialGradient id={`${uid}-glow`} cx="0.5" cy="0.42" r="0.58">
        <stop offset="0" stopColor="var(--pg-art-glow)" stopOpacity="0.86" />
        <stop offset="0.62" stopColor="var(--pg-art-glow)" stopOpacity="0.2" />
        <stop offset="1" stopColor="var(--pg-art-glow)" stopOpacity="0" />
      </radialGradient>
      <linearGradient id={`${uid}-vignette`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="var(--pg-art-shadow)" stopOpacity="0.24" />
        <stop offset="0.34" stopColor="var(--pg-art-shadow)" stopOpacity="0" />
        <stop offset="0.8" stopColor="var(--pg-art-shadow)" stopOpacity="0" />
        <stop offset="1" stopColor="var(--pg-art-shadow)" stopOpacity="0.4" />
      </linearGradient>
      <linearGradient id={`${uid}-beam`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="var(--pg-art-glow)" stopOpacity="0.62" />
        <stop offset="1" stopColor="var(--pg-art-glow)" stopOpacity="0.02" />
      </linearGradient>
    </defs>
  )
}

export function NewProjectArtwork(): ReactElement {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  return (
    <svg
      className={styles.newArtwork}
      viewBox="0 0 400 300"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      data-new-artwork
    >
      <ArtDefs uid={uid} />
      <path
        d="M64 256V116c0-42 60-68 136-68s136 26 136 68v140"
        fill="none"
        stroke="var(--purple)"
        strokeOpacity="0.42"
        strokeWidth="2"
        strokeDasharray="7 10"
      />
      <path d="M22 256h356" stroke="var(--purple)" strokeOpacity="0.34" strokeWidth="2" />
      <path d="M196 48 154 244h92Z" fill={`url(#${uid}-beam)`} opacity="0.55" />
      <path
        d="M84 256c26-12 58-18 116-18s90 6 116 18"
        fill="none"
        stroke="var(--purple)"
        strokeOpacity="0.26"
        strokeWidth="2"
      />
      <g fill="var(--purple)">
        <circle cx="126" cy="112" r="2" opacity="0.36" />
        <circle cx="282" cy="92" r="1.5" opacity="0.3" />
        <circle cx="304" cy="172" r="2.2" opacity="0.24" />
        <circle cx="104" cy="190" r="1.4" opacity="0.26" />
      </g>
    </svg>
  )
}

export function LibraryStateArtwork({ failed = false }: { failed?: boolean }): ReactElement {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  return (
    <svg
      className={`${styles.stateArtwork} ${styles.stateArtworkStage} ${failed ? styles.stateArtworkFailed : ''}`}
      viewBox="0 0 640 400"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      data-empty-artwork
      data-state-artwork={failed ? 'failed' : 'empty'}
    >
      <ArtDefs uid={uid} />
      <rect width="640" height="400" fill={`url(#${uid}-sky)`} />
      <path
        d="M48 346V132c0-54 120-86 272-86s272 32 272 86v214Z"
        fill="var(--pg-art-haze)"
        opacity="0.1"
      />
      <path d="M320 18 168 346h304Z" fill={`url(#${uid}-beam)`} opacity="0.72" />
      <ellipse cx="320" cy="336" rx="166" ry="26" fill="var(--pg-art-glow)" opacity="0.26" />
      <g fill="var(--pg-art-curtain)">
        <path d="M0 0h154c-28 82-32 166-10 240 12 43 30 78 50 104H0Z" />
        <path d="M640 0H486c28 82 32 166 10 240-12 43-30 78-50 104h194Z" />
      </g>
      <g fill="var(--pg-art-curtain-front)" opacity="0.9">
        <path d="M0 0h96c-18 82-21 170-2 252 8 34 19 64 32 92H0Z" />
        <path d="M640 0h-96c18 82 21 170 2 252-8 34-19 64-32 92h126Z" />
      </g>
      <path
        d="M0 0h640v46c-54 30-104 30-160 0-54 30-104 30-160 0-54 30-104 30-160 0C106 76 54 76 0 46Z"
        fill="var(--pg-art-curtain-front)"
      />
      <g stroke="var(--pg-art-accent)" strokeOpacity="0.28" strokeWidth="1.5" fill="none">
        <path d="M132 0c-16 88-18 180 0 272M508 0c16 88 18 180 0 272" />
      </g>
      <path d="M0 368h640v32H0Z" fill="var(--pg-art-floor)" />
      <path d="M0 368h640M116 326h408" stroke="var(--pg-art-accent)" strokeOpacity="0.22" />
      <ellipse cx="320" cy="236" rx="52" ry="30" fill="var(--pg-art-glow)" opacity="0.28" />
      <g fill="var(--pg-art-ink)">
        <path d="M314 252h12v74h-12Z" opacity="0.94" />
        <path d="M298 326h44l14 14h-72Z" opacity="0.94" />
        <path d="M300 244h40l8 14h-56Z" opacity="0.94" />
        <path d="M304 230h32l-4 18h-24Z" opacity="0.94" />
      </g>
      <path d="M306 230h29l-3 14h-23Z" fill="var(--pg-art-paper)" opacity="0.9" />
      <path
        d="M310 235h19M310 241h12"
        fill="none"
        stroke="var(--pg-art-ink)"
        strokeOpacity="0.48"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M306 230h29l-3 14h-23Z"
        fill="none"
        stroke="var(--pg-art-accent)"
        strokeOpacity="0.5"
        strokeWidth="1.2"
      />
      <g fill="var(--pg-art-seat)">
        <path d="M60 356h64c8 0 14 6 14 14v30H46v-30c0-8 6-14 14-14Z" />
        <path d="M196 356h64c8 0 14 6 14 14v30h-92v-30c0-8 6-14 14-14Z" />
        <path d="M332 356h64c8 0 14 6 14 14v30h-92v-30c0-8 6-14 14-14Z" />
        <path d="M468 356h64c8 0 14 6 14 14v30h-92v-30c0-8 6-14 14-14Z" />
      </g>
      <g fill="none" stroke="var(--pg-art-seat-front)" strokeOpacity="0.8" strokeWidth="2">
        <path d="M92 360v40M228 360v40M364 360v40M500 360v40" />
      </g>
      <g fill="none" stroke="var(--pg-art-accent)" strokeOpacity="0.14" strokeWidth="1.4">
        <path d="M54 366h76M190 366h76M326 366h76M462 366h76" />
      </g>
      <g fill="var(--pg-art-seat-front)">
        <path d="M0 386h640v14H0Z" />
      </g>
      <g fill="var(--pg-art-accent)">
        <circle cx="236" cy="120" r="2.2" opacity="0.55" />
        <circle cx="408" cy="92" r="1.6" opacity="0.45" />
        <circle cx="474" cy="164" r="2.4" opacity="0.4" />
        <circle cx="178" cy="196" r="1.5" opacity="0.48" />
        <circle cx="368" cy="182" r="1.3" opacity="0.36" />
      </g>
      <rect width="640" height="400" fill={`url(#${uid}-vignette)`} />
    </svg>
  )
}
