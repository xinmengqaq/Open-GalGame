import { useId, type ReactElement } from 'react'

/** 聚光里的浮尘：横坐标、纵坐标、半径、透明度。只做轻微漂移，不承载信息。 */
const MOTES: readonly (readonly [number, number, number, number])[] = [
  [138, 92, 1.2, 0.42],
  [168, 86, 0.9, 0.32],
  [154, 108, 1.6, 0.5],
  [184, 116, 1.1, 0.38],
  [132, 126, 0.8, 0.28],
  [176, 138, 1.4, 0.4],
  [146, 152, 1, 0.3],
  [196, 154, 1.2, 0.36],
  [124, 168, 1.1, 0.28],
  [162, 172, 0.9, 0.34],
  [186, 184, 1.5, 0.28],
  [140, 188, 1.2, 0.24],
  [206, 104, 0.8, 0.26],
  [118, 146, 0.9, 0.24],
  [200, 196, 1, 0.2],
  [152, 202, 0.9, 0.18]
]

/**
 * 空态的中性主视觉：空舞台、聚光、帷幕和浮尘，纯内联 SVG、无远程资源，不指向具体场景，
 * 也不冒充画布缩略图。`animated` 只让聚光轻微呼吸、浮尘缓慢漂移。
 */
export function SceneArt({
  animated = false,
  className = ''
}: {
  animated?: boolean
  className?: string
}): ReactElement {
  const rawId = useId()
  const id = rawId.replace(/[^a-zA-Z0-9_-]/g, '')
  const sky = `sky-${id}`
  const warmth = `warmth-${id}`
  const opening = `opening-${id}`
  const floor = `floor-${id}`
  const curtain = `curtain-${id}`
  const beam = `beam-${id}`
  const beamCore = `beam-core-${id}`
  const halo = `halo-${id}`
  const blur = `blur-${id}`
  const blurSoft = `blur-soft-${id}`

  return (
    <div className={`wb-gen-art ${className}`}>
      <svg aria-hidden="true" className="wb-gen-art__svg" viewBox="0 0 320 240">
        <defs>
          <linearGradient id={sky} x1="0" x2="0.22" y1="0" y2="1">
            <stop offset="0" stopColor="#f8f2fb" />
            <stop offset="0.5" stopColor="#f1e7f3" />
            <stop offset="1" stopColor="#e4f0eb" />
          </linearGradient>
          <radialGradient id={warmth} cx="0.5" cy="0.12" r="0.62">
            <stop offset="0" stopColor="#fff6e3" stopOpacity="0.9" />
            <stop offset="0.46" stopColor="#fff6e3" stopOpacity="0.34" />
            <stop offset="1" stopColor="#fff6e3" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={opening} x1="0" x2="0.05" y1="0" y2="1">
            <stop offset="0" stopColor="#fffdfb" stopOpacity="0.92" />
            <stop offset="0.6" stopColor="#fff8e9" stopOpacity="0.6" />
            <stop offset="1" stopColor="#eaf5f0" stopOpacity="0.86" />
          </linearGradient>
          <linearGradient id={floor} x1="0" x2="0.12" y1="0" y2="1">
            <stop offset="0" stopColor="#d9eae4" stopOpacity="0.5" />
            <stop offset="1" stopColor="#b6d7ce" stopOpacity="0.52" />
          </linearGradient>
          <linearGradient id={curtain} x1="0" x2="1" y1="0" y2="0.55">
            <stop offset="0" stopColor="#e6d6ee" stopOpacity="0.92" />
            <stop offset="0.55" stopColor="#dbc6e8" stopOpacity="0.78" />
            <stop offset="1" stopColor="#f1e7f6" stopOpacity="0.5" />
          </linearGradient>
          <linearGradient id={beam} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#fff3c4" stopOpacity="0.5" />
            <stop offset="0.58" stopColor="#fff6d8" stopOpacity="0.2" />
            <stop offset="1" stopColor="#fff6e3" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={beamCore} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#fffdf4" stopOpacity="0.58" />
            <stop offset="0.62" stopColor="#fff8dd" stopOpacity="0.22" />
            <stop offset="1" stopColor="#fff8dd" stopOpacity="0" />
          </linearGradient>
          <radialGradient id={halo} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#fffdf0" stopOpacity="0.95" />
            <stop offset="0.44" stopColor="#fff2c4" stopOpacity="0.42" />
            <stop offset="1" stopColor="#fff2c4" stopOpacity="0" />
          </radialGradient>
          <filter id={blur} height="200%" width="220%" x="-60%" y="-50%">
            <feGaussianBlur stdDeviation="9" />
          </filter>
          <filter id={blurSoft} height="220%" width="240%" x="-70%" y="-60%">
            <feGaussianBlur stdDeviation="4" />
          </filter>
        </defs>

        <rect fill={`url(#${sky})`} height="240" width="320" />
        <rect fill={`url(#${warmth})`} height="240" width="320" />

        <path
          d="M62 214V140c0-36.4 29.6-66 66-66h64c36.4 0 66 29.6 66 66v74Z"
          fill={`url(#${opening})`}
          stroke="var(--purple)"
          strokeOpacity="0.4"
          strokeWidth="1.2"
        />

        <path d="M62 178h196v36H62Z" fill={`url(#${floor})`} />
        <path d="M62 178h196" stroke="var(--teal)" strokeOpacity="0.3" strokeWidth="1.2" />
        <ellipse
          cx="160"
          cy="200"
          fill="none"
          rx="70"
          ry="12"
          stroke="var(--teal)"
          strokeOpacity="0.16"
          strokeWidth="1.2"
        />
        <ellipse
          cx="160"
          cy="200"
          fill="none"
          rx="46"
          ry="7.5"
          stroke="var(--teal)"
          strokeOpacity="0.22"
          strokeWidth="1.2"
        />
        <ellipse
          cx="160"
          cy="198"
          fill="#fff6ce"
          filter={`url(#${blur})`}
          opacity="0.55"
          rx="54"
          ry="11"
        />

        <path
          d="M62 214V132c0-24 16-44 38-52 3-1 6-1 8 0-6 21-8 43-6 65 1 24 5 48 12 69Z"
          fill={`url(#${curtain})`}
        />
        <path
          d="M258 214V132c0-24-16-44-38-52-3-1-6-1-8 0 6 21 8 43 6 65-1 24-5 48-12 69Z"
          fill={`url(#${curtain})`}
        />
        <g
          fill="none"
          stroke="var(--purple)"
          strokeLinecap="round"
          strokeOpacity="0.2"
          strokeWidth="1.2"
        >
          <path d="M74 138c-1 25 0 50 4 76" />
          <path d="M87 118c-3 30-1 63 5 96" />
          <path d="M246 138c1 25 0 50-4 76" />
          <path d="M233 118c3 30 1 63-5 96" />
        </g>

        <path
          d="M160 58 92 214h136Z"
          fill={`url(#${beam})`}
          filter={`url(#${blur})`}
          opacity="0.9"
        />
        <path
          d="M160 60 124 210h72Z"
          fill={`url(#${beamCore})`}
          filter={`url(#${blurSoft})`}
          opacity="0.7"
        />

        <g className={animated ? 'wb-gen-art__glow is-animated' : 'wb-gen-art__glow'}>
          <circle cx="160" cy="54" fill={`url(#${halo})`} r="52" />
          <circle cx="160" cy="54" fill="#fffdf4" opacity="0.85" r="5" />
          <circle
            cx="160"
            cy="54"
            fill="none"
            opacity="0.32"
            r="11"
            stroke="var(--cream)"
            strokeWidth="1.2"
          />
        </g>

        <g className={animated ? 'wb-gen-art__dust is-animated' : 'wb-gen-art__dust'}>
          {MOTES.map(([cx, cy, radius, opacity], index) => (
            <circle
              className="wb-gen-art__mote"
              cx={cx}
              cy={cy}
              fill="#e7cfa2"
              key={`${cx}-${cy}`}
              opacity={opacity}
              r={radius}
              style={{ animationDelay: `${(index * 0.68).toFixed(2)}s` }}
            />
          ))}
        </g>
      </svg>
      <div className="wb-gen-art__veil" />
    </div>
  )
}
