import { useRef, type ReactElement } from 'react'

import styles from './GuideFigures.module.css'
import { useGuideConnectionMotion } from './useGuideMotion'

/**
 * 邀请主视觉：纸页经过画布端口，收进一扇能试玩的舞台窗。
 * 后景的两层柔光、幽灵卡和连接线先落，前景才压纸页、端口和窗口；
 * 线条与填充全部取自局部 workbench 变量，不抢标题。
 */
export function GuideInviteFigure(): ReactElement {
  return (
    <svg
      className={styles.inviteFigure}
      viewBox="0 0 432 152"
      role="img"
      aria-label="一页剧本经过画布端口，做成一场能试玩的戏"
    >
      <ellipse className={styles.inviteHalo} cx="216" cy="70" rx="202" ry="56" />
      <circle className={styles.inviteAura} cx="366" cy="66" r="56" />
      <ellipse className={styles.inviteFloor} cx="216" cy="124" rx="162" ry="11" />

      <path className={styles.inviteThread} d="M128 76C158 76 172 76 194 76" />
      <path className={styles.inviteThread} d="M260 76C280 76 288 76 306 76" />
      <path className={styles.inviteSpark} d="M178 70l5 6-5 6" />
      <path className={styles.inviteSpark} d="M292 70l5 6-5 6" />

      <rect className={styles.inviteGhost} x="34" y="38" width="104" height="88" rx="12" />
      <path
        className={styles.inviteCard}
        d="M24 42a12 12 0 0 1 12-12h66l16 16v52a12 12 0 0 1-12 12H36a12 12 0 0 1-12-12z"
      />
      <path className={styles.inviteFold} d="M102 30v11a5 5 0 0 0 5 5h11" />
      <path className={styles.inviteInkStrong} d="M40 46h26" />
      <path className={styles.inviteInk} d="M40 58h50M40 70h42M40 82h48M40 94h30" />
      <circle className={styles.inviteDot} cx="40" cy="105" r="2.4" />
      <circle className={styles.inviteDotSoft} cx="48" cy="105" r="2.4" />
      <circle className={styles.inviteDotSoft} cx="56" cy="105" r="2.4" />

      <ellipse className={styles.invitePortHalo} cx="227" cy="76" rx="42" ry="23" />
      <circle className={styles.invitePort} cx="210" cy="76" r="16" />
      <circle className={styles.invitePort} cx="244" cy="76" r="16" />
      <path className={styles.invitePortLink} d="M226 76h12" />
      <path className={styles.invitePlus} d="M210 70v12M204 76h12M244 70v12M238 76h12" />

      <rect className={styles.inviteGhostStage} x="318" y="38" width="104" height="88" rx="14" />
      <rect className={styles.inviteStage} x="306" y="32" width="108" height="88" rx="14" />
      <path className={styles.inviteStageBar} d="M306 50h108" />
      <circle className={styles.inviteDotSoft} cx="318" cy="41" r="2.2" />
      <circle className={styles.inviteDotSoft} cx="326" cy="41" r="2.2" />
      <circle className={styles.inviteDotSoft} cx="334" cy="41" r="2.2" />
      <path className={styles.inviteStageLight} d="M326 96l16-28h36l16 28z" />
      <circle className={styles.invitePlay} cx="360" cy="73" r="13" />
      <path className={styles.invitePlayMark} d="M356 66l10 7-10 7z" />
      <path className={styles.inviteCaption} d="M320 108h52" />
      <path className={styles.inviteCaptionSoft} d="M320 114h32" />

      <g className={styles.inviteLabels} aria-hidden="true">
        <circle cx="76" cy="132" r="1.8" />
        <text x="84" y="135">
          剧本
        </text>
        <circle cx="223" cy="132" r="1.8" />
        <text x="231" y="135">
          画布
        </text>
        <circle cx="354" cy="132" r="1.8" />
        <text x="362" y="135">
          试玩
        </text>
      </g>
    </svg>
  )
}

interface GuideConnectionFigureProps {
  playToken: number
}

/**
 * 第 4 步的操作图解：左「剧本」、右「背景图」两张卡各有一只端口，
 * 中间的线只在用户点「播放连线」后从剧本一侧长到背景图一侧，
 * 最后落在关系名「开场时显示」。图内不接真实画布，也不派发业务事件。
 */
export function GuideConnectionFigure({ playToken }: GuideConnectionFigureProps): ReactElement {
  const lineRef = useRef<SVGPathElement>(null)
  const labelRef = useRef<SVGGElement>(null)
  const leftPortRef = useRef<SVGCircleElement>(null)
  const rightPortRef = useRef<SVGCircleElement>(null)

  useGuideConnectionMotion({ playToken, lineRef, labelRef, leftPortRef, rightPortRef })

  return (
    <svg
      className={styles.connectionFigure}
      viewBox="0 0 432 236"
      role="img"
      aria-label="左侧剧本卡和右侧背景图卡各有一只端口，中间的关系线上写着「开场时显示」"
    >
      <rect className={styles.stage} x="1" y="1" width="430" height="234" rx="20" />
      <ellipse className={styles.stageFloor} cx="216" cy="208" rx="160" ry="11" />

      <g className={styles.endLabel}>
        <circle className={styles.endLabelDot} cx="76" cy="33" r="2.2" />
        <text x="85" y="37">
          剧本
        </text>
        <circle className={styles.endLabelDot} cx="313" cy="33" r="2.2" />
        <text x="322" y="37">
          背景图
        </text>
      </g>

      <rect className={styles.cardGhost} x="16" y="44" width="140" height="132" rx="18" />
      <rect className={styles.card} x="24" y="52" width="140" height="132" rx="18" />
      <path className={styles.cardFold} d="M144 52v12a8 8 0 0 0 8 8h12" />
      <path className={styles.docTitle} d="M44 76h36" />
      <path className={styles.docLine} d="M44 96h90M44 110h78M44 124h84M44 138h56" />
      <circle className={styles.docPause} cx="50" cy="158" r="2.4" />
      <circle className={styles.docPauseSoft} cx="60" cy="158" r="2.4" />
      <circle className={styles.docPauseSoft} cx="70" cy="158" r="2.4" />

      <rect className={styles.cardGhost} x="274" y="44" width="140" height="132" rx="18" />
      <rect className={styles.card} x="268" y="52" width="140" height="132" rx="18" />
      <rect className={styles.mediaFrame} x="280" y="66" width="116" height="68" rx="9" />
      <circle className={styles.mediaSun} cx="370" cy="84" r="7" />
      <path
        className={styles.mediaHillBack}
        d="M286 132v-13c12-8 23-8 33 0 10 8 22 9 33 1 6-4 12-6 17-6 5 0 10 1 15 3v15z"
      />
      <path
        className={styles.mediaHillFront}
        d="M286 132v-7c11-6 22-6 32 0 10 6 21 6 31 0 5-3 10-4 15-4 5 0 10 1 14 3v8z"
      />
      <rect className={styles.mediaOutline} x="280" y="66" width="116" height="68" rx="9" />
      <path className={styles.docLineSoft} d="M280 150h66M280 162h42" />

      <path className={styles.connectionTrack} d="M164 118C196 98 240 138 268 118" />
      <path
        ref={lineRef}
        className={styles.connectionLine}
        d="M164 118C196 98 240 138 268 118"
        pathLength={1}
      />

      <circle className={styles.portHalo} cx="164" cy="118" r="17" />
      <circle ref={leftPortRef} className={styles.portPulse} cx="164" cy="118" r="12" />
      <circle className={styles.portCore} cx="164" cy="118" r="7.5" />
      <path className={styles.portPlus} d="M164 114.5v7M160.5 118h7" />

      <circle className={styles.portHalo} cx="268" cy="118" r="17" />
      <circle ref={rightPortRef} className={styles.portPulse} cx="268" cy="118" r="12" />
      <circle className={styles.portCore} cx="268" cy="118" r="7.5" />
      <path className={styles.portPlus} d="M268 114.5v7M264.5 118h7" />

      <g ref={labelRef} className={styles.relation}>
        <rect className={styles.relationPill} x="170" y="103" width="92" height="30" rx="15" />
        <text className={styles.relationText} x="216" y="118.5">
          开场时显示
        </text>
      </g>
    </svg>
  )
}
