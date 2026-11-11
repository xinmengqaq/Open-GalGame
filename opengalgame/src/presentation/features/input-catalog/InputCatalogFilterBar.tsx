import { clsx } from 'clsx'
import { useRef, useState, type ReactElement } from 'react'

import { TextInput } from '../../components/FormField'
import { SearchIcon } from '../../pages/workbench/WorkbenchIcons'
import { CloseIcon } from './InputCatalogIcons'
import { catalogGroupOptions, catalogTypeOptions } from './inputCatalogFilters'
import type { CatalogGroup, CatalogTypeFilter } from './inputCatalog.types'
import { useGroupSwitchMotion, useSearchFocusMotion } from './useInputCatalogMotion'
import styles from './InputCatalogPanel.module.css'

interface InputCatalogFilterBarProps {
  query: string
  group: CatalogGroup
  type: CatalogTypeFilter
  onQuery: (value: string) => void
  onGroup: (value: CatalogGroup) => void
  onType: (value: CatalogTypeFilter) => void
}

/** 搜索、分组与来源类型筛选。分组指示块与焦点线由目录动效拥有。 */
export function InputCatalogFilterBar({
  query,
  group,
  type,
  onQuery,
  onGroup,
  onType
}: InputCatalogFilterBarProps): ReactElement {
  const searchRef = useRef<HTMLDivElement>(null)
  const groupRef = useRef<HTMLDivElement>(null)
  const [searchFocused, setSearchFocused] = useState(false)
  useSearchFocusMotion(searchRef, searchFocused)
  useGroupSwitchMotion(groupRef, group)

  return (
    <div className={styles.filters}>
      <div ref={searchRef} className={clsx(styles.search, searchFocused && styles.searchFocused)}>
        <span className={styles.searchIcon} data-search-icon aria-hidden="true">
          <SearchIcon />
        </span>
        <TextInput
          id="input-catalog-search"
          value={query}
          placeholder="搜索来源名称"
          aria-label="搜索工程来源"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onQuery(event.target.value)}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
        />
        <span className={styles.searchRule} data-search-rule aria-hidden="true" />
        {query ? (
          <button
            type="button"
            className={styles.searchClear}
            aria-label="清空搜索"
            onClick={() => onQuery('')}
          >
            <CloseIcon />
          </button>
        ) : null}
      </div>

      <div ref={groupRef} className={styles.groupTabs} role="group" aria-label="来源分组">
        <span className={styles.groupThumb} data-group-thumb aria-hidden="true" />
        {catalogGroupOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            className={styles.groupTab}
            data-group-tab={option.value}
            aria-pressed={group === option.value}
            onClick={() => {
              onGroup(option.value)
              onType('all')
            }}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className={styles.typeRow}>
        <span className={styles.typeLabel}>类型</span>
        <div className={styles.typeChips} role="group" aria-label="筛选来源类型">
          {catalogTypeOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={styles.typeChip}
              data-kind={option.value}
              aria-pressed={type === option.value}
              onClick={() => onType(option.value)}
            >
              <span className={styles.typeChipDot} data-kind={option.value} aria-hidden="true" />
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
