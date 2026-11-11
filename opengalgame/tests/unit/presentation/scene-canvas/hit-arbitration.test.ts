import { describe, expect, it } from 'vitest'

import { CANVAS_PORT_MIN_SCREEN_PX } from '@presentation/features/scene-canvas/canvasZoomHitArea'
import {
  PORT_CENTER_BULLSEYE_SCREEN,
  PORT_HIT_RADIUS_SCREEN,
  SAFE_TRIANGLE_HALF_WIDTH_SCREEN,
  SAFE_TRIANGLE_LENGTH_SCREEN,
  SAME_GESTURE_TOLERANCE_SCREEN,
  correctAnchorConnectTarget,
  hitCandidateContains,
  pointInAnchorGlyph,
  pointInSafeTriangle,
  resolveAnchorContainerTarget,
  resolveCanvasHit,
  safeTriangleFromAnchor,
  shouldArbitrateCanvasHit,
  shouldForwardClickAtRedirectedPress,
  shouldRedirectCanvasHit,
  type AnchorHitCandidate,
  type CanvasHitCandidate,
  type CanvasPoint,
  type PortHitCandidate
} from '@presentation/features/scene-canvas/hitArbitration'

/**
 * 真实 0.32 缩放夹具：由页面 probe 在 1920×945、dpr1 下实测 getBoundingClientRect 抽取，
 * 含 7 张卡片、14 个端口热区、11 个关系锚点。夹具随仓库提交，测试不读 evidence 目录。
 * nodeCenter / labelArea 来自第二轮页面验收的 hover 展开实测（r2-hover-diag.json）。
 */
import measure032 from './fixtures/measure-032.json'

type FixtureRect = { x: number; y: number; width: number; height: number }

type FixturePort = {
  key: string
  cardId: string
  rect: FixtureRect
  center: CanvasPoint
}

type FixtureAnchor = {
  relationId: string
  labelText: string
  dotRect: FixtureRect
  /** 收起态光点中心：页面点击发生的位置（hover 展开后光点会平移）。 */
  center: CanvasPoint
  /** 锚点节点矩形中心：hover 展开标签时不移动，仲裁用它当锚点中心。 */
  nodeCenter: CanvasPoint
  nodeCenterSource: 'hover-diag-node-rect' | 'collapsed-dot-center-approx' | 'page-r5b-probe-handle-center'
  /** hover 展开后的标签按钮矩形；两个与端口重叠的锚点为实测展开态。 */
  labelArea?: FixtureRect
  labelAreaState?: 'expanded-hover'
  /** 记录装载 handle 的屏幕矩形；低缩放下相邻锚点的 handle 会互相叠压。 */
  recordHandleArea?: FixtureRect
  recordHandleSource?: 'page-r3-loadmap' | 'page-r5b-probe'
}

type Fixture = {
  zoom: number
  zoomPercentText: string
  transform: { zoom: number }
  cards: { id: string; center: CanvasPoint }[]
  ports: FixturePort[]
  anchors: FixtureAnchor[]
}

const fixture = measure032 as unknown as Fixture

/** 实测锚点标识：两个落在端口热区内的锚点，以及被它们压住的相邻端口。 */
const MIO_RIGHT_PORT_KEY = '794073f7-beff-49db-8133-77f83e7cc20c:right'
const YUU_LEFT_PORT_KEY = '859de58e-b622-4870-8e3c-563bc6410e48:left'
const CLASSMATE_ANCHOR_ID = '5985d0f1-339d-4942-8a3d-93f8ab860b8c'
const PROMPT_ANCHOR_ID = '2937a074-8494-4d41-8794-9c0a5a1b37f1'

function nearestCardCenter(point: CanvasPoint): CanvasPoint | null {
  let nearest: CanvasPoint | null = null
  let nearestDistance = Number.POSITIVE_INFINITY
  for (const card of fixture.cards) {
    const distance = Math.hypot(point.x - card.center.x, point.y - card.center.y)
    if (distance < nearestDistance) {
      nearest = card.center
      nearestDistance = distance
    }
  }
  return nearest
}

function toPortCandidate(port: FixturePort): PortHitCandidate {
  return {
    kind: 'port',
    id: port.key,
    center: port.center,
    radius: PORT_HIT_RADIUS_SCREEN
  }
}

function toAnchorCandidate(anchor: FixtureAnchor): AnchorHitCandidate {
  const center = anchor.nodeCenter
  return {
    kind: 'anchor',
    id: anchor.relationId,
    center,
    area: anchor.dotRect,
    triangle: safeTriangleFromAnchor(center, nearestCardCenter(center)),
    ...(anchor.labelArea ? { labelArea: anchor.labelArea } : {}),
    ...(anchor.recordHandleArea ? { recordHandleArea: anchor.recordHandleArea } : {})
  }
}

const portCandidates = fixture.ports.map(toPortCandidate)
const anchorCandidates = fixture.anchors.map(toAnchorCandidate)
const candidates: CanvasHitCandidate[] = [...portCandidates, ...anchorCandidates]

function fixtureAnchorOf(id: string): FixtureAnchor {
  const found = fixture.anchors.find((anchor) => anchor.relationId === id)
  if (!found) throw new Error(`夹具缺少锚点 ${id}`)
  return found
}

function portCandidateOf(key: string): PortHitCandidate {
  const found = portCandidates.find((candidate) => candidate.id === key)
  if (!found) throw new Error(`夹具缺少端口 ${key}`)
  return found
}

function anchorCandidateOf(id: string): AnchorHitCandidate {
  const found = anchorCandidates.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`夹具缺少锚点 ${id}`)
  return found
}

function labelAreaOf(anchor: AnchorHitCandidate): FixtureRect {
  if (!anchor.labelArea) throw new Error(`锚点 ${anchor.id} 缺少 labelArea`)
  return anchor.labelArea
}

function anchorHandleAreaOf(anchor: AnchorHitCandidate): FixtureRect {
  if (!anchor.recordHandleArea) throw new Error(`锚点 ${anchor.id} 缺少 recordHandleArea`)
  return anchor.recordHandleArea
}

function rectContains(rect: FixtureRect, point: CanvasPoint): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  )
}

function resolveAt(point: CanvasPoint): CanvasHitCandidate {
  const resolved = resolveCanvasHit(point, candidates)
  if (!resolved) throw new Error(`(${point.x}, ${point.y}) 未命中任何候选`)
  return resolved
}

function syntheticPort(center: CanvasPoint, radius: number = 10): PortHitCandidate {
  return { kind: 'port', id: 'port-a', center, radius }
}

function syntheticAnchor(center: CanvasPoint, labelArea?: FixtureRect): AnchorHitCandidate {
  return {
    kind: 'anchor',
    id: 'anchor-a',
    center,
    area: { x: center.x - 5, y: center.y - 5, width: 10, height: 10 },
    triangle: safeTriangleFromAnchor(center, null),
    ...(labelArea ? { labelArea } : {})
  }
}

describe('低缩放画布命中仲裁（0.32 缩放真实几何）', () => {
  it('夹具来自 0.32 缩放实测：7 卡 / 14 端口 / 11 锚点，端口热区为 28px 屏幕补偿', () => {
    expect(fixture.cards).toHaveLength(7)
    expect(fixture.ports).toHaveLength(14)
    expect(fixture.anchors).toHaveLength(11)
    expect(fixture.zoom).toBe(0.32)
    expect(fixture.zoomPercentText).toBe('32%')
    expect(Math.abs(fixture.transform.zoom - fixture.zoom)).toBeLessThan(0.001)
    for (const port of fixture.ports) {
      expect(port.rect.width).toBeCloseTo(CANVAS_PORT_MIN_SCREEN_PX, 1)
      expect(port.rect.height).toBeCloseTo(CANVAS_PORT_MIN_SCREEN_PX, 1)
    }
    for (const anchor of fixture.anchors) {
      expect(anchor.dotRect.width).toBeCloseTo(2.88, 2)
      expect(anchor.dotRect.height).toBeCloseTo(2.88, 2)
      expect(Number.isFinite(anchor.nodeCenter.x)).toBe(true)
      expect(Number.isFinite(anchor.nodeCenter.y)).toBe(true)
      expect(['hover-diag-node-rect', 'collapsed-dot-center-approx', 'page-r5b-probe-handle-center'])
        .toContain(anchor.nodeCenterSource)
    }
  })

  it('两个重叠锚点带 hover 展开实测：节点中心稳定，标签区为展开态', () => {
    const classmate = fixtureAnchorOf(CLASSMATE_ANCHOR_ID)
    const prompt = fixtureAnchorOf(PROMPT_ANCHOR_ID)

    // 5985 展开时光点左移 17.6px，节点中心仍停在 (1175.36,443.19)。
    expect(classmate.nodeCenter.x).toBeCloseTo(1175.36, 2)
    expect(classmate.nodeCenter.y).toBeCloseTo(443.19, 2)
    expect(Math.abs(classmate.nodeCenter.x - classmate.center.x)).toBeCloseTo(0.48, 2)
    expect(classmate.nodeCenterSource).toBe('page-r5b-probe-handle-center')
    expect(classmate.labelArea).toMatchObject({ x: 1155.84, y: 439.35, width: 31.04, height: 7.68 })
    expect(classmate.labelAreaState).toBe('expanded-hover')

    expect(prompt.nodeCenter.x).toBeCloseTo(1180.48, 2)
    expect(prompt.nodeCenter.y).toBeCloseTo(445.27, 2)
    expect(prompt.nodeCenterSource).toBe('page-r5b-probe-handle-center')
    expect(prompt.labelArea).toMatchObject({ x: 1168.08, y: 442.05, width: 25.44, height: 6.44 })
  })

  it('14 个端口中心各自命中自身，不串到相邻端口或锚点', () => {
    for (const port of fixture.ports) {
      expect(resolveAt(port.center)).toMatchObject({ kind: 'port', id: port.key })
    }
  })

  it('11 个锚点收起态光点中心各自命中自身', () => {
    for (const anchor of fixture.anchors) {
      expect(resolveAt(anchor.center)).toMatchObject({
        kind: 'anchor',
        id: anchor.relationId
      })
    }
  })

  it('端口中心被展开标签覆盖时，bullseye 仍把事件转派给端口', () => {
    const mioRight = portCandidateOf(MIO_RIGHT_PORT_KEY)
    const yuuLeft = portCandidateOf(YUU_LEFT_PORT_KEY)
    const classmate = anchorCandidateOf(CLASSMATE_ANCHOR_ID)
    const prompt = anchorCandidateOf(PROMPT_ANCHOR_ID)

    expect(resolveAt(mioRight.center)).toMatchObject({ kind: 'port', id: MIO_RIGHT_PORT_KEY })
    expect(shouldRedirectCanvasHit(mioRight.center, resolveAt(mioRight.center), classmate)).toBe(
      true
    )
    expect(resolveAt(yuuLeft.center)).toMatchObject({ kind: 'port', id: YUU_LEFT_PORT_KEY })
    expect(shouldRedirectCanvasHit(yuuLeft.center, resolveAt(yuuLeft.center), prompt)).toBe(true)

    // 两个端口中心确实落在对应展开标签区内，bullseye 必须优先于标签保护。
    expect(rectContains(labelAreaOf(classmate), mioRight.center)).toBe(true)
    expect(rectContains(labelAreaOf(prompt), yuuLeft.center)).toBe(true)
  })

  it('锚点收起态光点中心不转派端口，放行给锚点自身', () => {
    const classmate = anchorCandidateOf(CLASSMATE_ANCHOR_ID)
    const prompt = anchorCandidateOf(PROMPT_ANCHOR_ID)

    const classmateResolved = resolveAt(classmate.center)
    expect(classmateResolved).toMatchObject({ kind: 'anchor', id: CLASSMATE_ANCHOR_ID })
    expect(shouldRedirectCanvasHit(classmate.center, classmateResolved, classmate)).toBe(false)

    const promptResolved = resolveAt(prompt.center)
    expect(promptResolved).toMatchObject({ kind: 'anchor', id: PROMPT_ANCHOR_ID })
    expect(shouldRedirectCanvasHit(prompt.center, promptResolved, prompt)).toBe(false)
  })

  it('页面回归：hover 展开后点击收起态光点中心仍是锚点，不再被端口抢走', () => {
    const classmate = anchorCandidateOf(CLASSMATE_ANCHOR_ID)
    const prompt = anchorCandidateOf(PROMPT_ANCHOR_ID)

    // 稳定节点中心：点击点（收起态光点中心）距锚点中心 0.48/0.004px，距端口 4.81/2.25px。
    expect(resolveAt(classmate.center)).toMatchObject({ kind: 'anchor', id: CLASSMATE_ANCHOR_ID })
    expect(resolveAt(prompt.center)).toMatchObject({ kind: 'anchor', id: PROMPT_ANCHOR_ID })

    // 旧几何用展开后左移的光点中心，这两个点才会掉进端口 14px 热区——回归的直接原因。
    expect(resolveAt({ x: 1157.28, y: 443.19 })).toMatchObject({
      kind: 'port',
      id: MIO_RIGHT_PORT_KEY
    })
    expect(resolveAt({ x: 1169.52, y: 445.27 })).toMatchObject({
      kind: 'port',
      id: MIO_RIGHT_PORT_KEY
    })
  })

  it('端口热区内的展开标签点：端口中心更近时归端口，标签覆盖不改变最近中心裁决', () => {
    const classmate = anchorCandidateOf(CLASSMATE_ANCHOR_ID)
    const prompt = anchorCandidateOf(PROMPT_ANCHOR_ID)

    const classmateLabelPoint = { x: 1165, y: 443.03 }
    expect(rectContains(labelAreaOf(classmate), classmateLabelPoint)).toBe(true)
    const classmateResolved = resolveAt(classmateLabelPoint)
    expect(classmateResolved).toMatchObject({ kind: 'port', id: MIO_RIGHT_PORT_KEY })
    // 距澪右端口中心 5.08px > bullseye，但比 5985 锚点稳定中心（10.36px）更近：按最近中心裁决归端口。
    expect(shouldRedirectCanvasHit(classmateLabelPoint, classmateResolved, classmate)).toBe(true)

    const promptLabelPoint = { x: 1172, y: 444.5 }
    expect(rectContains(labelAreaOf(prompt), promptLabelPoint)).toBe(true)
    const promptResolved = resolveAt(promptLabelPoint)
    expect(promptResolved).toMatchObject({ kind: 'port', id: MIO_RIGHT_PORT_KEY })
    expect(shouldRedirectCanvasHit(promptLabelPoint, promptResolved, prompt)).toBe(true)
  })

  it('端口热区之外的标签仍归锚点，低缩放规则不扩大到热区外', () => {
    const port = syntheticPort({ x: 0, y: 0 }, 10)
    const anchor = syntheticAnchor({ x: 18, y: 0 }, { x: 12, y: -3, width: 5, height: 6 })
    const point = { x: 14, y: 0 }
    expect(rectContains(labelAreaOf(anchor), point)).toBe(true)
    expect(hitCandidateContains(point, port)).toBe(false)
    const resolved = resolveCanvasHit(point, [port, anchor])
    expect(resolved).toMatchObject({ kind: 'anchor', id: anchor.id })
    expect(shouldRedirectCanvasHit(point, resolved!, anchor)).toBe(false)
  })

  it('两个相邻端口 28px 热区重叠 17.75px，重叠区按最近中心归属', () => {
    const mioRight = portCandidateOf(MIO_RIGHT_PORT_KEY)
    const yuuLeft = portCandidateOf(YUU_LEFT_PORT_KEY)
    const centerDistance = Math.hypot(
      mioRight.center.x - yuuLeft.center.x,
      mioRight.center.y - yuuLeft.center.y
    )
    expect(CANVAS_PORT_MIN_SCREEN_PX - centerDistance).toBeCloseTo(17.754, 3)

    // 两端口热区的重叠区（避开锚点光点盒与三角）按距离归属，不按 DOM 顺序。
    expect(resolveAt({ x: 1175, y: 448 })).toMatchObject({
      kind: 'port',
      id: MIO_RIGHT_PORT_KEY
    })
    expect(resolveAt({ x: 1175.4, y: 448 })).toMatchObject({
      kind: 'port',
      id: YUU_LEFT_PORT_KEY
    })
  })

  it('安全三角从稳定锚点中心朝最近卡片中心：5985/2937 均朝悠卡一侧', () => {
    const classmate = anchorCandidateOf(CLASSMATE_ANCHOR_ID)
    const prompt = anchorCandidateOf(PROMPT_ANCHOR_ID)

    for (const candidate of [classmate, prompt]) {
      const nearest = nearestCardCenter(candidate.center)
      if (!nearest) throw new Error('夹具缺少卡片')
      const dx = nearest.x - candidate.center.x
      const dy = nearest.y - candidate.center.y
      const length = Math.hypot(dx, dy)
      expect(candidate.triangle.direction.x).toBeCloseTo(dx / length, 5)
      expect(candidate.triangle.direction.y).toBeCloseTo(dy / length, 5)
      // 稳定中心 (1175.36 / 1180.48) 都在两卡中点 (1175.20) 右侧，最近卡片是悠卡。
      expect(candidate.triangle.direction.x).toBeGreaterThan(0)
    }

    // 回归根因：旧几何用展开后左移的光点中心，5985 反而朝左（澪卡侧）。
    const oldCenter = fixtureAnchorOf(CLASSMATE_ANCHOR_ID).center
    const oldTriangle = safeTriangleFromAnchor(oldCenter, nearestCardCenter(oldCenter))
    expect(oldTriangle.direction.x).toBeLessThan(0)
  })

  it('稳定中心的安全三角把锚点命中区扩到端口热区之外', () => {
    const point = { x: 1195, y: 443.19 }
    const classmate = anchorCandidateOf(CLASSMATE_ANCHOR_ID)
    expect(pointInSafeTriangle(point, classmate.triangle)).toBe(true)
    expect(hitCandidateContains(point, classmate)).toBe(true)
    // 悠左端口 14px 热区不覆盖该点（距离 14.677），三角补偿区仍然归锚点。
    expect(hitCandidateContains(point, portCandidateOf(YUU_LEFT_PORT_KEY))).toBe(false)
    expect(resolveAt(point).kind).toBe('anchor')
  })

  it('光点本体与安全三角分开判定：标签文字不参与光点纠偏', () => {
    const classmate = anchorCandidateOf(CLASSMATE_ANCHOR_ID)
    expect(pointInAnchorGlyph(fixtureAnchorOf(CLASSMATE_ANCHOR_ID).center, classmate)).toBe(true)
    expect(pointInAnchorGlyph({ x: 1195, y: 443.19 }, classmate)).toBe(false)
    expect(pointInSafeTriangle({ x: 1195, y: 443.19 }, classmate.triangle)).toBe(true)
  })

  it('所有候选区之外返回 null，不介入', () => {
    expect(resolveCanvasHit({ x: 1100, y: 300 }, candidates)).toBeNull()
    expect(resolveCanvasHit({ x: 1400, y: 443 }, candidates)).toBeNull()
  })

  it('同距时端口优先，端口之间按 id 稳定排序', () => {
    const anchorTie: AnchorHitCandidate = {
      kind: 'anchor',
      id: 'anchor-a',
      center: { x: 10, y: 0 },
      area: { x: 0, y: -5, width: 20, height: 10 },
      triangle: safeTriangleFromAnchor({ x: 10, y: 0 }, null)
    }
    const portA: PortHitCandidate = {
      kind: 'port',
      id: 'port-a',
      center: { x: 0, y: 0 },
      radius: 10
    }
    const portB: PortHitCandidate = {
      kind: 'port',
      id: 'port-b',
      center: { x: 0, y: 0 },
      radius: 10
    }

    expect(resolveCanvasHit({ x: 5, y: 0 }, [anchorTie, portA])?.kind).toBe('port')
    expect(resolveCanvasHit({ x: 0, y: 0 }, [portB, portA])?.id).toBe('port-a')
  })

  it('三角方向缺失时退化为零方向，不会把任意点都判进三角', () => {
    const degenerate = safeTriangleFromAnchor({ x: 10, y: 10 }, null)
    expect(pointInSafeTriangle({ x: 15, y: 10 }, degenerate)).toBe(false)
    expect(pointInSafeTriangle({ x: 10, y: 10 }, degenerate)).toBe(false)
  })
})

describe('锚点容器隔离（记录装载 handle 叠压）', () => {
  it('夹具带页面实测记录 handle 矩形：5985 窄 handle 被 2937 宽 handle 叠压', () => {
    const classmate = fixtureAnchorOf(CLASSMATE_ANCHOR_ID)
    const prompt = fixtureAnchorOf(PROMPT_ANCHOR_ID)

    expect(classmate.nodeCenterSource).toBe('page-r5b-probe-handle-center')
    expect(classmate.recordHandleSource).toBe('page-r5b-probe')
    expect(classmate.recordHandleArea).toMatchObject({
      x: 1171.0408935546875,
      y: 438.3651123046875,
      width: 8.640625,
      height: 9.64068603515625
    })
    expect(prompt.nodeCenterSource).toBe('page-r5b-probe-handle-center')
    expect(prompt.recordHandleSource).toBe('page-r5b-probe')
    expect(prompt.recordHandleArea).toMatchObject({
      x: 1164.5604248046875,
      y: 440.7652587890625,
      width: 31.84228515625,
      height: 9.00067138671875
    })

    // 页面复验根因：5985 的 handle 中心落在 2937 的宽 handle 矩形内。
    expect(
      rectContains(anchorHandleAreaOf(anchorCandidateOf(PROMPT_ANCHOR_ID)), classmate.nodeCenter)
    ).toBe(true)
  })

  it('点 5985 记录 handle 中心归 5985，不再被上层 2937 handle 吃掉', () => {
    const winner = resolveAnchorContainerTarget(
      { x: 1175.361, y: 443.185 },
      anchorCandidates,
      CLASSMATE_ANCHOR_ID
    )
    expect(winner?.id).toBe(CLASSMATE_ANCHOR_ID)
  })

  it('点 2937 记录 handle 中心归 2937', () => {
    const winner = resolveAnchorContainerTarget(
      { x: 1180.482, y: 445.266 },
      anchorCandidates,
      PROMPT_ANCHOR_ID
    )
    expect(winner?.id).toBe(PROMPT_ANCHOR_ID)
  })

  it('页面复验场景：DOM 顶层落到 2937 宽 handle 时，点 5985 handle 中心仍归 5985', () => {
    // 页面 click 的 target/顶层元素是 2937 的宽 handle（actualRelationId=2937），
    // 但仲裁必须按容器最近的稳定中心把 winner 判给 5985；随后视口走应用层装载动作。
    const winner = resolveAnchorContainerTarget(
      { x: 1175.361, y: 443.185 },
      anchorCandidates,
      PROMPT_ANCHOR_ID
    )
    expect(winner?.id).toBe(CLASSMATE_ANCHOR_ID)
  })

  it('页面复验场景：DOM 顶层落到 5985 宽 handle 时，点 2937 handle 中心仍归 2937', () => {
    const winner = resolveAnchorContainerTarget(
      { x: 1180.482, y: 445.266 },
      anchorCandidates,
      CLASSMATE_ANCHOR_ID
    )
    expect(winner?.id).toBe(PROMPT_ANCHOR_ID)
  })

  it('点 5985 窄 handle 左缘（1172,443.19）归最近的 5985，不被宽 handle 抢走', () => {
    const point = { x: 1172, y: 443.19 }
    // 两个 handle 都覆盖该点，但 5985 的稳定中心（也是它自己的 handle 中心）更近。
    expect(rectContains(anchorHandleAreaOf(anchorCandidateOf(CLASSMATE_ANCHOR_ID)), point)).toBe(
      true
    )
    expect(rectContains(anchorHandleAreaOf(anchorCandidateOf(PROMPT_ANCHOR_ID)), point)).toBe(true)
    const winner = resolveAnchorContainerTarget(point, anchorCandidates, PROMPT_ANCHOR_ID)
    expect(winner?.id).toBe(CLASSMATE_ANCHOR_ID)
    // 修正 handle 归属后，5985 的窄 handle 不再覆盖旧的宽 handle 左缘。
    expect(resolveAnchorContainerTarget({ x: 1155, y: 443.19 }, anchorCandidates)).toBeNull()
  })

  it('锚点光点中心与标签文字仍归各自锚点，其它锚点容器不误抢', () => {
    expect(
      resolveAnchorContainerTarget(fixtureAnchorOf(CLASSMATE_ANCHOR_ID).center, anchorCandidates)
        ?.id
    ).toBe(CLASSMATE_ANCHOR_ID)
    // (1180,443.03) 在 2937 展开标签内，且到 2937 稳定中心比到 5985 更近。
    expect(resolveAnchorContainerTarget({ x: 1180, y: 443.03 }, anchorCandidates)?.id).toBe(
      PROMPT_ANCHOR_ID
    )
    expect(resolveAnchorContainerTarget({ x: 1165, y: 443.03 }, anchorCandidates)?.id).toBe(
      CLASSMATE_ANCHOR_ID
    )
  })

  it('所有锚点容器之外返回 null，保持原有放行行为', () => {
    expect(resolveAnchorContainerTarget({ x: 900, y: 300 }, anchorCandidates)).toBeNull()
    expect(resolveAnchorContainerTarget({ x: 1400, y: 443 }, anchorCandidates)).toBeNull()
    expect(resolveAnchorContainerTarget({ x: 1400, y: 443 }, anchorCandidates)).toBeNull()
  })

  it('同距时优先事件实际落点的锚点', () => {
    const first = syntheticAnchor({ x: 0, y: 0 })
    const second: AnchorHitCandidate = { ...syntheticAnchor({ x: 0, y: 0 }), id: 'anchor-b' }

    expect(resolveAnchorContainerTarget({ x: 0, y: 0 }, [first, second])?.id).toBe('anchor-a')
    expect(resolveAnchorContainerTarget({ x: 0, y: 0 }, [first, second], 'anchor-b')?.id).toBe(
      'anchor-b'
    )
  })

  it('保留 recordHandleElement 供调用方向正确 handle 转发', () => {
    const handleElement = { tagName: 'DIV' } as unknown as Element
    const withHandle: AnchorHitCandidate = {
      ...syntheticAnchor({ x: 0, y: 0 }),
      recordHandleArea: { x: -5, y: -5, width: 10, height: 10 },
      recordHandleElement: handleElement
    }

    const winner = resolveAnchorContainerTarget({ x: 0, y: 0 }, [withHandle])
    expect(winner?.recordHandleElement).toBe(handleElement)
  })
})

describe('仲裁缩放门限', () => {
  it('只在低缩放（<=0.6）介入，正常缩放与放大档不抢卡片点击', () => {
    expect(shouldArbitrateCanvasHit(0.32)).toBe(true)
    expect(shouldArbitrateCanvasHit(0.6)).toBe(true)
    expect(shouldArbitrateCanvasHit(0.61)).toBe(false)
    expect(shouldArbitrateCanvasHit(1)).toBe(false)
    expect(shouldArbitrateCanvasHit(1.8)).toBe(false)
  })

  it('未知或非法缩放不介入', () => {
    expect(shouldArbitrateCanvasHit(0)).toBe(false)
    expect(shouldArbitrateCanvasHit(-0.5)).toBe(false)
    expect(shouldArbitrateCanvasHit(Number.NaN)).toBe(false)
    expect(shouldArbitrateCanvasHit(Number.POSITIVE_INFINITY)).toBe(false)
  })
})

describe('转派判定的边界', () => {
  it('解析结果不是端口时不转派；非法坐标不转派', () => {
    const classmate = anchorCandidateOf(CLASSMATE_ANCHOR_ID)
    const port = portCandidateOf(MIO_RIGHT_PORT_KEY)
    expect(shouldRedirectCanvasHit(classmate.center, classmate, classmate)).toBe(false)
    expect(shouldRedirectCanvasHit({ x: Number.NaN, y: 443 }, port, classmate)).toBe(false)
    expect(
      shouldRedirectCanvasHit(
        port.center,
        port,
        syntheticAnchor({ x: Number.POSITIVE_INFINITY, y: 443 })
      )
    ).toBe(false)
  })

  it('端口中心 bullseye 内一律转派，即使标签区覆盖该点', () => {
    const port = syntheticPort({ x: 0, y: 0 })
    const anchor = syntheticAnchor({ x: 0.5, y: 0 }, { x: -2, y: -2, width: 6, height: 4 })
    const point = { x: 1, y: 0 }
    expect(rectContains(labelAreaOf(anchor), point)).toBe(true)
    expect(shouldRedirectCanvasHit(point, port, anchor)).toBe(true)
  })

  it('端口热区内标签点按最近中心裁决：端口更近时接收；热区外标签不受端口影响', () => {
    const port = syntheticPort({ x: 0, y: 0 })
    const anchor = syntheticAnchor({ x: 10, y: 0 }, { x: 0, y: -3, width: 6, height: 6 })
    const point = { x: 4.5, y: 0 }
    expect(rectContains(labelAreaOf(anchor), point)).toBe(true)
    // 端口距离 4.5 < 锚点距离 5.5，按最近中心裁决归端口，保住端口起连。
    expect(shouldRedirectCanvasHit(point, port, anchor)).toBe(true)
  })

  it('端口与锚点稳定中心同距时不转派，放行锚点', () => {
    const port = syntheticPort({ x: 0, y: 0 })
    const anchor = syntheticAnchor({ x: 10, y: 0 })
    expect(shouldRedirectCanvasHit({ x: 5, y: 0 }, port, anchor)).toBe(false)
    expect(shouldRedirectCanvasHit({ x: 4.9, y: 0 }, port, anchor)).toBe(true)
  })
})

describe('仲裁几何常量', () => {
  it('端口仲裁半径与 CSS 的 28px 屏幕热区一致，端口中心容差为 2px', () => {
    expect(CANVAS_PORT_MIN_SCREEN_PX).toBe(28)
    expect(PORT_HIT_RADIUS_SCREEN * 2).toBe(CANVAS_PORT_MIN_SCREEN_PX)
    expect(PORT_CENTER_BULLSEYE_SCREEN).toBe(2)
    expect(SAFE_TRIANGLE_LENGTH_SCREEN).toBe(24)
    expect(SAFE_TRIANGLE_HALF_WIDTH_SCREEN).toBe(10)
  })
})

describe('拖拽后补发 click 的同手势门控', () => {
  it('同一手势内（同点或 1px 内）允许继续转发 click', () => {
    const press = { x: 100, y: 200 }
    expect(shouldForwardClickAtRedirectedPress(press, { x: 100, y: 200 })).toBe(true)
    expect(shouldForwardClickAtRedirectedPress(press, { x: 101, y: 200 })).toBe(true)
    expect(shouldForwardClickAtRedirectedPress(press, { x: 100, y: 201 })).toBe(true)
  })

  it('超过 1px 的 click 视为新手势，不转发', () => {
    const press = { x: 100, y: 200 }
    expect(shouldForwardClickAtRedirectedPress(press, { x: 101.5, y: 200 })).toBe(false)
    expect(shouldForwardClickAtRedirectedPress(press, { x: 102, y: 200 })).toBe(false)
    expect(shouldForwardClickAtRedirectedPress(press, { x: 100, y: 198.5 })).toBe(false)
  })

  it('没有已重定向的按下时不转发：drag 完成后浏览器补发 click 的情形', () => {
    expect(shouldForwardClickAtRedirectedPress(null, { x: 1175.36, y: 443.19 })).toBe(false)
  })

  it('按下或 click 坐标非法时不转发', () => {
    expect(
      shouldForwardClickAtRedirectedPress({ x: Number.NaN, y: 200 }, { x: 100, y: 200 })
    ).toBe(false)
    expect(
      shouldForwardClickAtRedirectedPress(
        { x: Number.POSITIVE_INFINITY, y: 200 },
        { x: 100, y: 200 }
      )
    ).toBe(false)
    expect(
      shouldForwardClickAtRedirectedPress({ x: 100, y: 200 }, { x: Number.NaN, y: 200 })
    ).toBe(false)
  })

  it('默认容差为 1px，可显式传入其他容差且拒绝非法容差', () => {
    expect(SAME_GESTURE_TOLERANCE_SCREEN).toBe(1)
    expect(shouldForwardClickAtRedirectedPress({ x: 0, y: 0 }, { x: 0, y: 2 }, 2)).toBe(true)
    expect(shouldForwardClickAtRedirectedPress({ x: 0, y: 0 }, { x: 0, y: 2.01 }, 2)).toBe(false)
    expect(shouldForwardClickAtRedirectedPress({ x: 0, y: 0 }, { x: 0, y: 1 }, -1)).toBe(false)
    expect(shouldForwardClickAtRedirectedPress({ x: 0, y: 0 }, { x: 0, y: 1 }, Number.NaN)).toBe(
      false
    )
  })
})

describe('drag 装载锚点纠正（ISSUE-R5-02）', () => {
  const CLASSMATE_CONTACT = { x: 1175.3612060546875, y: 443.1854553222656 }
  const PROMPT_CONTACT = { x: 1180.4815673828125, y: 445.2655944824219 }

  it('真实叠压夹具：点 5985 handle 中心、库判到 2937 时纠正为 5985', () => {
    const classmate = anchorCandidateOf(CLASSMATE_ANCHOR_ID)
    // C1 页面证据的精确矩形：5985 的窄 handle 被 2937 的宽 handle 叠压。
    expect(classmate.center).toMatchObject(CLASSMATE_CONTACT)
    expect(anchorHandleAreaOf(anchorCandidateOf(PROMPT_ANCHOR_ID))).toMatchObject({
      x: 1164.5604248046875,
      y: 440.7652587890625,
      width: 31.84228515625,
      height: 9.00067138671875
    })

    expect(
      correctAnchorConnectTarget(CLASSMATE_CONTACT, PROMPT_ANCHOR_ID, anchorCandidates, 0.32)
    ).toBe(CLASSMATE_ANCHOR_ID)
  })

  it('库已判对时不纠正：点各自 handle 中心且 actual 与最近容器一致', () => {
    expect(
      correctAnchorConnectTarget(CLASSMATE_CONTACT, CLASSMATE_ANCHOR_ID, anchorCandidates, 0.32)
    ).toBeNull()
    expect(
      correctAnchorConnectTarget(PROMPT_CONTACT, PROMPT_ANCHOR_ID, anchorCandidates, 0.32)
    ).toBeNull()
  })

  it('不在低缩放档、target 不是关系锚点、落点缺失或非法时不纠正', () => {
    expect(
      correctAnchorConnectTarget(CLASSMATE_CONTACT, PROMPT_ANCHOR_ID, anchorCandidates, 0.61)
    ).toBeNull()
    expect(
      correctAnchorConnectTarget(CLASSMATE_CONTACT, PROMPT_ANCHOR_ID, anchorCandidates, 1)
    ).toBeNull()
    // 拖到卡片 target：relationIdOfAnchor 返回 null，视口按原样处理。
    expect(
      correctAnchorConnectTarget(CLASSMATE_CONTACT, null, anchorCandidates, 0.32)
    ).toBeNull()
    expect(correctAnchorConnectTarget(null, PROMPT_ANCHOR_ID, anchorCandidates, 0.32)).toBeNull()
    expect(
      correctAnchorConnectTarget(
        { x: Number.NaN, y: 443.19 },
        PROMPT_ANCHOR_ID,
        anchorCandidates,
        0.32
      )
    ).toBeNull()
  })

  it('落在所有锚点容器之外时不纠正，保持原连接', () => {
    expect(
      correctAnchorConnectTarget({ x: 900, y: 300 }, PROMPT_ANCHOR_ID, anchorCandidates, 0.32)
    ).toBeNull()
  })
})
