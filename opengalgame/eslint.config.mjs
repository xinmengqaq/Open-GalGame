import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import tseslint from '@electron-toolkit/eslint-config-ts'
import boundaries from 'eslint-plugin-boundaries'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig } from 'eslint/config'

export default defineConfig(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      '**/coverage',
      'scripts/**/*.cjs',
      'tests/electron/**/*.cjs',
      'tests/e2e/**/*.cjs',
      'playwright*.cjs'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      'no-duplicate-imports': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?:\\.\\./){3,}',
              message: '跨层导入请使用对应的 @别名。'
            }
          ]
        }
      ]
    }
  },
  {
    // shadcn/ui 与 AI Elements 注册表复制件保持上游签名，便于后续按注册表更新；
    // 业务代码仍按显式返回类型和只导出组件的要求书写。
    files: [
      'src/presentation/components/ui/**/*.{ts,tsx}',
      'src/presentation/components/ai-elements/**/*.{ts,tsx}'
    ],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      'react-refresh/only-export-components': [
        'error',
        {
          allowExportNames: [
            'buttonVariants',
            'buttonGroupVariants',
            'tabsListVariants',
            'messagesToMarkdown'
          ]
        }
      ]
    }
  },
  {
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?:\\.\\./)+src/',
              message: '测试引用 src/ 请使用对应的 @别名。'
            }
          ]
        }
      ]
    }
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      boundaries
    },
    settings: {
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: ['./tsconfig.node.json', './tsconfig.web.json']
        }
      },
      'boundaries/include': ['src/**/*.{ts,tsx}'],
      'boundaries/elements': [
        { type: 'bootstrap', pattern: 'src/bootstrap', mode: 'folder' },
        { type: 'presentation', pattern: 'src/presentation', mode: 'folder' },
        { type: 'application-contracts', pattern: 'src/application/*/dto', mode: 'folder' },
        { type: 'application-contracts', pattern: 'src/application/*/vo', mode: 'folder' },
        { type: 'interfaces', pattern: 'src/interfaces', mode: 'folder' },
        { type: 'application', pattern: 'src/application', mode: 'folder' },
        { type: 'domain', pattern: 'src/domain', mode: 'folder' },
        { type: 'infrastructure', pattern: 'src/infrastructure', mode: 'folder' },
        { type: 'common-errors', pattern: 'src/common/errors', mode: 'folder' },
        { type: 'common', pattern: 'src/common', mode: 'folder' }
      ]
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            {
              from: 'bootstrap',
              allow: [
                'presentation',
                'interfaces',
                'application',
                'domain',
                'infrastructure',
                'common',
                'common-errors'
              ]
            },
            {
              from: 'presentation',
              allow: ['interfaces', 'common', 'common-errors']
            },
            {
              from: 'interfaces',
              allow: ['application', 'interfaces', 'common', 'common-errors']
            },
            {
              from: 'application',
              allow: ['domain', 'application', 'common', 'common-errors']
            },
            {
              from: 'domain',
              allow: ['common-errors']
            },
            {
              from: 'infrastructure',
              allow: ['domain', 'application', 'common', 'common-errors']
            },
            {
              from: ['bootstrap', 'presentation', 'interfaces', 'application', 'infrastructure'],
              allow: ['application-contracts'],
              importKind: 'type'
            },
            {
              from: 'application-contracts',
              allow: ['application-contracts'],
              importKind: 'type'
            },
            {
              from: 'common',
              allow: ['common']
            },
            {
              from: 'common-errors',
              allow: ['common-errors']
            }
          ]
        }
      ]
    }
  },
  eslintConfigPrettier
)
