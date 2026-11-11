import type { ReactElement } from 'react'

import type { ProjectFolderVO } from '@application/project-files/vo/ProjectInputCatalogVO'
import { ChevronIcon, FolderUpIcon } from './InputCatalogIcons'
import type { CatalogFolderId } from './inputCatalog.types'
import styles from './InputCatalogPanel.module.css'

interface InputCatalogBreadcrumbsProps {
  folders: readonly ProjectFolderVO[]
  currentFolderId: CatalogFolderId
  onOpen: (folderId: CatalogFolderId) => void
}

/** 子目录显示祖先导航；根目录不重复占用一行。 */
export function InputCatalogBreadcrumbs({
  folders,
  currentFolderId,
  onOpen
}: InputCatalogBreadcrumbsProps): ReactElement {
  if (currentFolderId === null) return <></>

  return (
    <nav className={styles.crumbs} aria-label="当前目录">
      <button
        type="button"
        className={styles.crumb}
        aria-label="返回输入目录"
        title="返回输入目录"
        onClick={() => onOpen(null)}
      >
        <FolderUpIcon />
      </button>
      {folders.map((folder) => (
        <span key={folder.folderId} className={styles.crumbGroup}>
          <ChevronIcon className={styles.crumbSep} aria-hidden="true" />
          <button
            type="button"
            className={styles.crumb}
            data-current={folder.folderId === currentFolderId ? 'true' : undefined}
            aria-current={folder.folderId === currentFolderId ? 'page' : undefined}
            title={folder.name}
            onClick={() => onOpen(folder.folderId)}
          >
            <span className={styles.crumbText}>{folder.name}</span>
          </button>
        </span>
      ))}
    </nav>
  )
}
