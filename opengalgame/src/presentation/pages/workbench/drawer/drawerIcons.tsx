import type { ReactElement, SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

/** 抽屉品牌标记；只作装饰，不承担业务含义。 */
export function SparkleMark(props: IconProps): ReactElement {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" {...props}>
      <path
        d="M12 2.6c.7 4.9 2.5 6.7 7.4 7.4-4.9.7-6.7 2.5-7.4 7.4-.7-4.9-2.5-6.7-7.4-7.4 4.9-.7 6.7-2.5 7.4-7.4Z"
        fill="currentColor"
      />
      <path
        d="M19.2 15.2c.32 2.2 1.12 3 3.3 3.3-2.18.3-2.98 1.1-3.3 3.3-.3-2.2-1.1-3-3.3-3.3 2.2-.3 3-1.1 3.3-3.3Z"
        fill="currentColor"
        opacity=".55"
      />
    </svg>
  )
}

/** 自动保存分组的刻线节点，和手动保存的里程碑节点区分。 */
export function TicksGlyph(props: IconProps): ReactElement {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" {...props}>
      <path
        d="M7 6v12M12 4v16M17 8v8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.7"
      />
    </svg>
  )
}

/** 空态时间线标记。 */
export function TimelineGlyph(props: IconProps): ReactElement {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" {...props}>
      <path d="M6 3.6v16.8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
      <circle cx="6" cy="7.2" r="2" fill="currentColor" />
      <circle cx="6" cy="16.8" r="1.6" fill="currentColor" opacity=".55" />
      <path
        d="M10.2 7.2h8M10.2 16.8h5.4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.6"
      />
    </svg>
  )
}
