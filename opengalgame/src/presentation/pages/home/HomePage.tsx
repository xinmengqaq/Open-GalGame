import { useRef, type ReactElement } from 'react'

import brandMark from '../../assets/brand-mark.webp'
import { ArrowIcon, DownloadIcon, ListIcon, PlusIcon, SettingsIcon } from '../../components/Icons'
import { CreateProjectDialog } from '../../features/project-create/CreateProjectDialog'
import { useProjectCreate } from '../../features/project-create/useProjectCreate'
import { ImportResultDialog } from '../../features/project-import/ImportResultDialog'
import { useProjectImport } from '../../features/project-import/useProjectImport'
import { useNavigationStore } from '../../stores/navigation.store'
import styles from './HomePage.module.css'
import { HomeVisual } from './HomeVisual'
import { useHomeMotion } from './useHomeMotion'
import type { AppUpdateFlow } from '../../features/app-update/useAppUpdate'
import type { SettingsSectionId } from '../../features/settings/settingsNavigation'
import type { ProjectClient } from '@interfaces/client/ProjectClient'

interface HomePageProps {
  projectClient: ProjectClient
  appUpdate: AppUpdateFlow
  onOpenSettings: (section?: SettingsSectionId) => void
  onProjectCreated?: (projectId: string) => void
}

export function HomePage({
  projectClient,
  appUpdate,
  onOpenSettings,
  onProjectCreated
}: HomePageProps): ReactElement {
  const visit = useNavigationStore((state) => state.visit)
  const importing = useProjectImport(projectClient)
  const creating = useProjectCreate(projectClient, { onProjectCreated })
  const updateBadge =
    appUpdate.status?.phase === 'available'
      ? '有新版本'
      : appUpdate.status?.phase === 'downloaded'
        ? '待重启'
        : null

  const root = useRef<HTMLElement>(null)
  const title1 = useRef<HTMLSpanElement>(null)
  const title2 = useRef<HTMLSpanElement>(null)
  const accent = useRef<HTMLSpanElement>(null)
  const hero = useRef<HTMLImageElement>(null)
  const circle = useRef<HTMLDivElement>(null)
  const speech = useRef<HTMLDivElement>(null)
  const visual = useRef<HTMLDivElement>(null)
  const importButton = useRef<HTMLButtonElement>(null)
  const projectsButton = useRef<HTMLButtonElement>(null)
  const createButton = useRef<HTMLButtonElement>(null)
  const settingsButton = useRef<HTMLButtonElement>(null)
  const downloadIcon = useRef<SVGSVGElement>(null)
  const arrowIcon = useRef<SVGSVGElement>(null)
  const plusIcon = useRef<SVGSVGElement>(null)
  const gearIcon = useRef<SVGSVGElement>(null)

  useHomeMotion({
    root,
    title1,
    title2,
    accent,
    hero,
    circle,
    speech,
    visual,
    importButton,
    projectsButton,
    createButton,
    settingsButton,
    downloadIcon,
    arrowIcon,
    plusIcon,
    gearIcon
  })

  return (
    <section className={styles.screen} ref={root} aria-label="首页">
      <div className={styles.wash} data-motion="wash" aria-hidden="true" />
      <div className={styles.rays} aria-hidden="true" />
      <header className={styles.header} data-motion="chrome">
        <div className={styles.brand}>
          <img className={styles.mark} src={brandMark} alt="" />
          <span>
            OPENGALGAME <small>／ 想象力开场</small>
          </span>
        </div>
        <div className={styles.headerRight}>
          {updateBadge === null ? null : (
            <span className={styles.updateBadge} role="status" aria-live="polite">
              {updateBadge}
            </span>
          )}
          <button
            data-guide-target="model-open"
            data-settings-opener
            ref={settingsButton}
            className={styles.settings}
            type="button"
            onClick={() => onOpenSettings()}
          >
            <SettingsIcon ref={gearIcon} />
            设置
          </button>
        </div>
      </header>
      <main className={styles.stage}>
        <div className={styles.copy}>
          <p className={styles.kicker}>
            <span>开场</span>
            从第一句写到分叉
          </p>
          <svg className={styles.flower} viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2.5 13.6 9h6.9l-5.6 4.1 2.1 6.4L12 15.8 6.99 19.5l2.1-6.4L3.5 9h6.9Z" />
          </svg>
          <h1>
            <span className={styles.titleLine}>
              <span className={styles.titleInner} ref={title1}>
                把心动写成
              </span>
            </span>
            <span className={styles.titleLine}>
              <span className={styles.titleInner} ref={title2}>
                <span className={styles.accent} ref={accent}>
                  可以选择的
                </span>
                故事。
              </span>
            </span>
          </h1>
          <p className={styles.lead}>
            一个角色，一句台词。
            <br />
            下一幕的分叉，由你来写。
          </p>
          <div className={styles.actions}>
            <button
              ref={importButton}
              className={styles.primary}
              type="button"
              data-motion="entry"
              onClick={() => void importing.importProject()}
            >
              <span className={styles.iconBox}>
                <DownloadIcon ref={downloadIcon} />
              </span>
              <span className={styles.primaryLabel}>导入项目</span>
              <ArrowIcon ref={arrowIcon} className={styles.arrow} />
            </button>
            <div className={styles.row}>
              <button
                data-guide-target="projects-open"
                ref={projectsButton}
                className={styles.secondary}
                type="button"
                data-motion="entry"
                onClick={() => visit('projects')}
              >
                <span className={styles.iconSlot}>
                  <ListIcon />
                </span>
                项目选择
              </button>
              <button
                data-guide-target="project-create"
                ref={createButton}
                className={styles.secondary}
                type="button"
                data-motion="entry"
                onClick={creating.open}
              >
                <span className={styles.iconSlot}>
                  <span className={styles.plusHalo} data-plus-halo aria-hidden="true" />
                  <PlusIcon ref={plusIcon} />
                </span>
                新建空白画布
              </button>
            </div>
          </div>
        </div>
        <HomeVisual visualRef={visual} heroRef={hero} circleRef={circle} speechRef={speech} />
      </main>
      <footer className={styles.footer} data-motion="chrome">
        <span>故事写在这里</span>
        <span>随时可以再玩一遍</span>
      </footer>
      <ImportResultDialog
        state={importing.state}
        name={importing.result?.name}
        error={importing.error}
        onClose={importing.dismiss}
        onRebuildWorkspace={importing.rebuildWorkspace}
      />
      <CreateProjectDialog flow={creating} />
    </section>
  )
}
