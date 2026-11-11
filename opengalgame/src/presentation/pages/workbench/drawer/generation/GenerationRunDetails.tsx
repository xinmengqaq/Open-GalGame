import { Activity, Check, ChevronDown, Sparkles } from 'lucide-react'
import type { ReactElement } from 'react'

import type { SceneGenerationRenderStage } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import { Task, TaskTrigger } from '@presentation/components/ai-elements/task'
import { Popover, PopoverContent, PopoverTrigger } from '@presentation/components/ui/popover'
import { CountUp } from '../CountUp'
import { historyClock } from './generationHistoryPresentation'
import {
  formatCount,
  generationStages,
  stageRailIndex,
  tokenViewOf
} from './generationPresentation'
import type { GenerationRunView } from './generationRunView'

const stageLabels: Record<SceneGenerationRenderStage, string> = {
  readingInput: '读取输入',
  generating: '生成候选',
  validating: '校验 / 修正',
  waitingReview: '等待审阅',
  committing: '提交',
  completed: '已提交',
  failed: '运行结束',
  cancelled: '已取消',
  paused: '已暂停'
}

function phaseLabelOf(view: GenerationRunView): string {
  switch (view.phase) {
    case 'preparing':
      return '准备中'
    case 'running':
      return stageLabels[view.stage] === '运行结束' ? '生成中' : stageLabels[view.stage]
    case 'waiting':
      return '等待你的回复'
    case 'committing':
      return '提交中'
    case 'paused':
      return '已暂停'
    case 'cancelling':
      return '正在取消'
    case 'failed':
      return view.failure?.unverified === true
        ? '结果待核对'
        : view.runState === 'interrupted'
          ? '运行中断'
          : '生成失败'
    case 'cancelled':
      return '已取消'
    case 'completed':
      return '已提交'
    default:
      return '当前生成'
  }
}

function phaseToneOf(view: GenerationRunView): 'live' | 'wait' | 'muted' | 'danger' | 'done' {
  switch (view.phase) {
    case 'paused':
    case 'cancelled':
      return 'muted'
    case 'failed':
      return 'danger'
    case 'completed':
      return 'done'
    case 'waiting':
      return 'wait'
    default:
      return 'live'
  }
}

function isTerminalView(view: GenerationRunView): boolean {
  return view.phase === 'paused' || view.phase === 'failed' || view.phase === 'cancelled'
}

function terminationNoteOf(view: GenerationRunView): string {
  if (view.phase === 'paused') return '已暂停，阶段轨不再推进；继续后会从原检查点接着执行。'
  if (view.phase === 'cancelled') return '已取消，阶段轨不再推进。'
  return '本次运行已结束，阶段轨不再推进。'
}

function activityLabelOf(view: GenerationRunView): string {
  const activity = view.activity
  if (!activity) return '没有记录'
  const time = historyClock(activity.lastActivityAt)
  if (activity.kind === 'waitingModel') return `等待模型响应 · ${time}`
  if (activity.kind === 'tool') return `工具调用 · ${time}`
  return `模型响应 · ${time}`
}

function callCountLabel(count: number | undefined): string {
  return count === undefined ? '没有记录' : `${formatCount(count)} 次`
}

function progressStageLabelOf(stage: SceneGenerationRenderStage): string {
  return stageLabels[stage]
}

interface GenerationRunDetailsPanelProps {
  view: GenerationRunView
}

/**
 * 运行详情的纯内容：六步阶段轨、Token、调用与活动、最近安全进度。
 * 不显示耗时；暂停、失败和取消不给活动节点，只显示终止说明。
 */
export function GenerationRunDetailsPanel({ view }: GenerationRunDetailsPanelProps): ReactElement {
  const railIndex = stageRailIndex(view.stage)
  const tokens = tokenViewOf(view.usage)
  const recent = view.progress.slice(-6)
  const terminal = isTerminalView(view)
  const stateLabel =
    railIndex === null
      ? '阶段已停止'
      : railIndex >= generationStages.length
        ? '六步完成'
        : `第 ${railIndex + 1} / ${generationStages.length} 步`

  return (
    <div className="wb-gen-details">
      <header className="wb-gen-details__head">
        <div className="wb-gen-details__heading">
          <p className="wb-gen-details__eyebrow">
            <Activity aria-hidden="true" />
            运行详情
          </p>
          <h3 className="wb-gen-details__title">{phaseLabelOf(view)}</h3>
        </div>
        <span className="wb-gen-details__state" data-tone={phaseToneOf(view)}>
          {stateLabel}
        </span>
      </header>

      <section className="wb-gen-details__section">
        <div className="wb-gen-details__section-head">
          <h4>阶段</h4>
          <span>固定六步</span>
        </div>
        <ol aria-label="生成阶段" className="wb-gen-details__stages">
          {generationStages.map((stage, index) => {
            const state =
              railIndex === null
                ? 'idle'
                : index < railIndex
                  ? 'done'
                  : index === railIndex
                    ? 'active'
                    : 'pending'
            return (
              <li className="wb-gen-details__stage" data-state={state} key={stage.key}>
                <span className="wb-gen-details__top">
                  <span aria-hidden="true" className="wb-gen-details__step">
                    {state === 'done' ? <Check /> : index + 1}
                  </span>
                  {index < generationStages.length - 1 ? (
                    <span aria-hidden="true" className="wb-gen-details__line" />
                  ) : null}
                </span>
                <span className="wb-gen-details__label">{stage.label}</span>
              </li>
            )
          })}
        </ol>
        {railIndex === null && terminal ? (
          <p className="wb-gen-details__note">{terminationNoteOf(view)}</p>
        ) : null}
      </section>

      <section className="wb-gen-details__section">
        <div className="wb-gen-details__section-head">
          <h4>Token</h4>
          <span>本次操作累计</span>
        </div>
        <div aria-label="本次操作累计 Token" className="wb-gen-details__tokens">
          <div className="wb-gen-details__token">
            <span>输入</span>
            <strong>
              <CountUp value={view.usage.inputTokens} />
            </strong>
          </div>
          <div className="wb-gen-details__token">
            <span>输出</span>
            <strong>
              <CountUp value={view.usage.outputTokens} />
            </strong>
          </div>
          <div className="wb-gen-details__token wb-gen-details__token--total">
            <span>总计</span>
            <strong>
              <CountUp value={view.usage.totalTokens} />
            </strong>
          </div>
        </div>
        {tokens.limitLabel === null ? null : (
          <p className="wb-gen-details__limit">{tokens.limitLabel}</p>
        )}
      </section>

      <section className="wb-gen-details__section">
        <div className="wb-gen-details__section-head">
          <h4>调用与活动</h4>
          <span>本次操作</span>
        </div>
        <dl className="wb-gen-details__metrics">
          <div>
            <dt>模型调用</dt>
            <dd>{callCountLabel(view.usage.modelCalls)}</dd>
          </div>
          <div>
            <dt>工具调用</dt>
            <dd>{callCountLabel(view.usage.toolCalls)}</dd>
          </div>
          <div className="wb-gen-details__metric--wide">
            <dt>最近活动</dt>
            <dd>{activityLabelOf(view)}</dd>
          </div>
        </dl>
      </section>

      <section className="wb-gen-details__section">
        <div className="wb-gen-details__section-head">
          <h4>最近进度</h4>
          <span>{recent.length === 0 ? '还没有记录' : `最近 ${recent.length} 条`}</span>
        </div>
        {recent.length === 0 ? (
          <p className="wb-gen-details__empty">还没有可显示的进度说明。</p>
        ) : (
          <ol className="wb-gen-details__progress">
            {recent.map((step, index) => (
              <li
                className="wb-gen-details__progress-item"
                data-current={!terminal && index === recent.length - 1}
                key={`${step.sequence}:${step.stage}`}
              >
                <span className="wb-gen-details__sequence">
                  {String(step.sequence).padStart(2, '0')}
                </span>
                <span className="wb-gen-details__progress-stage">
                  {progressStageLabelOf(step.stage)}
                </span>
                <span className="wb-gen-details__progress-message">{step.message}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}

/** 运行详情浮层内容；紧凑行和终态文字入口共用同一份锚定与外观。 */
function RunDetailsPopoverContent({ view }: { view: GenerationRunView }): ReactElement {
  return (
    <PopoverContent
      align="start"
      aria-label="运行详情"
      className="wb-gen-details-popover"
      collisionPadding={12}
      side="bottom"
      sideOffset={8}
    >
      <GenerationRunDetailsPanel view={view} />
    </PopoverContent>
  )
}

interface GenerationRunDetailsProps {
  view: GenerationRunView
  /**
   * `quiet` 用于终态气泡底部的文字动作入口。它不是紧凑进度行，
   * 保留轻量 button 作为设计绑定的有意例外，不再套 Task/TaskTrigger。
   */
  variant?: 'pill' | 'quiet'
  label?: string
}

/**
 * 运行详情浮层。入口锚定触发按钮，宽度 360–420px、最大高度不超过 60vh 且
 * 留在窗口内，由 Radix 负责 Esc/外点关闭、焦点返回和空间不足时翻转。
 */
export function GenerationRunDetails({
  view,
  variant = 'pill',
  label = '查看运行详情'
}: GenerationRunDetailsProps): ReactElement {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={variant === 'quiet' ? 'wb-gen-details-link' : 'wb-gen-run__trigger'}
          type="button"
        >
          {variant === 'quiet' ? <Activity aria-hidden="true" /> : null}
          <span>{label}</span>
          <ChevronDown aria-hidden="true" className="wb-gen-run__chevron" />
        </button>
      </PopoverTrigger>
      <RunDetailsPopoverContent view={view} />
    </Popover>
  )
}

/** 当前生成里的紧凑进度行；点击整行打开运行详情。 */
export function GenerationRunStrip({ view }: { view: GenerationRunView }): ReactElement {
  const railIndex = stageRailIndex(view.stage)
  const animated =
    view.phase === 'preparing' ||
    view.phase === 'running' ||
    view.phase === 'committing' ||
    view.phase === 'cancelling'
  const meta =
    railIndex !== null && railIndex < generationStages.length
      ? `${phaseLabelOf(view)} · 第 ${railIndex + 1} / ${generationStages.length} 步`
      : phaseLabelOf(view)

  return (
    <Popover>
      {/* 设计绑定要求运行详情入口使用 Task/TaskTrigger；展开内容由 Popover 承载，
          Collapsible 只保留触发语义，不参与展开状态。 */}
      <Task className="wb-gen-run" onOpenChange={() => undefined} open={false}>
        <PopoverTrigger asChild>
          <TaskTrigger
            aria-label={`查看运行详情：${view.stageMessage}`}
            className="wb-gen-run__row"
            title="查看运行详情"
          >
            <button type="button">
              <span aria-hidden="true" className="wb-gen-run__orb" data-live={animated}>
                <Sparkles />
              </span>
              <span className="wb-gen-run__copy">
                <span className="wb-gen-run__title">{view.stageMessage}</span>
                <span className="wb-gen-run__meta">{meta}</span>
              </span>
              {animated ? <span aria-hidden="true" className="wb-gen-run__pulse" /> : null}
              <span className="wb-gen-run__trigger">
                <span>查看运行详情</span>
                <ChevronDown aria-hidden="true" className="wb-gen-run__chevron" />
              </span>
            </button>
          </TaskTrigger>
        </PopoverTrigger>
      </Task>
      <RunDetailsPopoverContent view={view} />
    </Popover>
  )
}
