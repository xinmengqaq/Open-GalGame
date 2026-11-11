import { useRef, type ReactElement } from 'react'

import { Button } from '../../components/Button'
import { workbenchFeedback } from '../../feedback/workbenchFeedback'
import { ImportIcon } from '../../pages/workbench/WorkbenchIcons'
import { FolderIcon, FolderPlusIcon, SparkIcon } from './InputCatalogIcons'
import { useStateArtMotion } from './useInputCatalogMotion'
import styles from './InputCatalogPanel.module.css'

interface InputCatalogEmptyStateProps {
  onImport: () => void
  onCreateFolder: () => void
}

/** 扫描成功但工程里没有任何来源和文件夹。刷新由顶栏统一负责。 */
export function InputCatalogEmptyState({
  onImport,
  onCreateFolder
}: InputCatalogEmptyStateProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  useStateArtMotion(ref)

  return (
    <div ref={ref} className={styles.state} data-testid="catalog-empty">
      <div className={styles.emptyArt} aria-hidden="true">
        <span className={styles.emptyArtHalo} data-state-art="" />
        <span className={styles.emptyArtFile} data-state-art="">
          <i />
          <i />
          <i />
        </span>
        <span className={styles.emptyArtFolder} data-state-art="">
          <FolderIcon open />
          <span className={styles.emptyArtPlus}>+</span>
        </span>
        <span className={styles.emptyArtSpark} data-state-art="" aria-hidden="true">
          <SparkIcon />
        </span>
      </div>
      <p className={styles.stateTitle}>{workbenchFeedback.emptyCatalog}</p>
      <p className={styles.stateHint}>
        导入文档和素材，或先建一个文件夹整理本场景的输入。导入后会出现在这里。
      </p>
      <div className={styles.stateActions}>
        <Button className={styles.statePrimary} onClick={onImport}>
          <ImportIcon />
          导入文件
        </Button>
        <Button className={styles.stateSecondary} variant="secondary" onClick={onCreateFolder}>
          <FolderPlusIcon />
          新建文件夹
        </Button>
      </div>
    </div>
  )
}
