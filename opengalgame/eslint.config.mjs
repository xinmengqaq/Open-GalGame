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
      '**/output/**',
      '**/coverage',
      'artifacts/**',
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
            'buttonGroupVariants'
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
        { type: 'application-contracts', pattern: 'src/application/*/*/dto', mode: 'folder' },
        { type: 'application-contracts', pattern: 'src/application/*/*/vo', mode: 'folder' },
        { type: 'interfaces', pattern: 'src/interfaces', mode: 'folder' },
        { type: 'application', pattern: 'src/application', mode: 'folder' },
        { type: 'domain', pattern: 'src/domain', mode: 'folder' },
        { type: 'infrastructure', pattern: 'src/infrastructure', mode: 'folder' },
        {
          type: 'common-operation-id',
          pattern: 'src/common/contracts/OperationId.ts',
          mode: 'full'
        },
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
                'common-errors',
                'common-operation-id'
              ]
            },
            {
              from: 'presentation',
              allow: ['interfaces', 'common', 'common-errors']
            },
            {
              from: 'interfaces',
              allow: [
                'application',
                'interfaces',
                'common',
                'common-errors',
                'common-operation-id'
              ]
            },
            {
              from: 'application',
              allow: [
                'domain',
                'application',
                'common',
                'common-errors',
                'common-operation-id'
              ]
            },
            {
              from: 'domain',
              allow: ['common-errors', 'common-operation-id']
            },
            {
              from: 'infrastructure',
              allow: [
                'domain',
                'application',
                'common',
                'common-errors',
                'common-operation-id'
              ]
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
  {
    files: ['src/presentation/pages/workbench/drawer/generation/generationPresentation.ts'],
    rules: {
      'boundaries/element-types': 'off'
    }
  },
  eslintConfigPrettier
)
