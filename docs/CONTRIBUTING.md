# 贡献指南

欢迎参与 OpenGalgame。这是一个画布式的 AI Galgame 创作工具：你在画布上整理角色、设定、素材和提示词，AI 负责生成单个 WebGAL 场景候选，只有经你预览、修改并确认后，内容才会写入作品。

当前版本提供的是单场景 AI 辅助生成，不是自由聊天助手。对话机器人、通用 Agent 和整部作品一键生成目前尚未实现；如果你对这些方向感兴趣，建议先开 Issue 聊聊思路。

不管你想怎么参与都很欢迎：

- 提 Bug 或功能建议
- 优化界面、交互和文案
- 补代码、测试或文档
- 帮忙在不同 Windows 环境下做实测

目前只面向 Windows x64 发布，暂不支持 macOS 和 Linux。

## 开始之前

- 提问题前先搜一下现有 Issue，看看是不是已经有人提过。
- 大功能、架构调整或跨模块改动，先开 Issue 聊清楚场景、方案和影响范围再动手；小修小补、改文案或补测试直接提 PR 就行。
- 报 Bug 时尽量附上 OpenGalgame 版本、Windows 版本、复现步骤、预期和实际结果，以及相关日志。发日志和截图前记得先脱敏。

## 本地启动

环境要求：Node.js >= 22.19.0、npm 和 Git。

```bash
git clone --recurse-submodules https://github.com/xinmengqaq/Open-GalGame.git
cd opengalgame
npm run build:md-blockkit
npm ci
npm run dev
```

`md-blockkit` 没发到 npm，而是通过 Git submodule 指向 [md-blockkit](https://github.com/xinmengqaq/md-blockkit)，主应用用 `file:` 依赖引用它，所以首次启动前必须先构建它的 `dist/`。如果克隆时忘了加 `--recurse-submodules`，先在仓库根目录跑一次 `git submodule update --init --recursive`，再回到 `opengalgame/` 执行 `npm run build:md-blockkit` 和 `npm ci`。

其余脚本可以看 `opengalgame/package.json`。

## 项目结构

应用源码在 `opengalgame/src`，按五层划分：


| 目录             | 职责                          |
| ---------------- | ----------------------------- |
| `presentation`   | 页面、画布和交互              |
| `interfaces`     | IPC/客户端接口与协议校验      |
| `application`    | 用例编排、DTO/VO、端口        |
| `domain`         | 业务模型和规则                |
| `infrastructure` | 文件、Git、模型、WebGAL、日志 |

`bootstrap` 负责把各层装起来。写新代码时尽量放在对应的层里；涉及跨层改动，或者需要新增文件、命令、IPC 入口时，先在 Issue 里说明用途和边界。渲染进程不直接碰磁盘也不保存密钥，需要文件或模型能力时，统一通过 preload 暴露的固定接口进主进程。

测试在 `opengalgame/tests/` 下，分 `unit`、`integration` 和 `e2e` 三类。

## 开发与验证

- 改了功能或修 Bug 记得补测试，优先写能直接覆盖该行为的最小测试。
- 提交前跑一遍 typecheck、lint 和相关测试，具体命令见 `opengalgame/package.json`。
- 改了界面请在实际应用窗口里点一遍确认效果，并在 PR 里附截图或录屏。
- 代码风格沿用现有约定，格式和静态检查分别用 Prettier 和 ESLint 跑过。
- commit 信息写清楚改了什么、为什么改，尽量保持一个 commit 只做一件事。

## 提交 Pull Request

1. 从 `main` 拉一个语义清晰的新分支开发（外部贡献者请先 Fork）。
2. 改完后跑通相关检查和测试，目标分支选 `main`。
3. 在 PR 描述里写清楚背景、改动范围、用户可见变化、验证方式以及还没验证的部分；有界面改动的话附上截图或录屏。
4. 关联了 Issue 的话顺手在描述里贴上链接。

一个 PR 尽量只解决一个问题，把功能改动、重构和无关的格式化拆开，Review 起来会快很多。如果改动越写越大，拆成几个小 PR 更容易合入。

## 关于 AI 辅助

可以用 AI 工具辅助写代码、测试或文档，但提 PR 前请自己看懂代码、跑通验证，不要把没验证过的生成内容直接丢过来。

如果你用 AI agent 辅助开发，除了上面的通用要求，再按下面这些更严格的标准自查：

- 界面：复用现有组件和图标；纯图标控件要有可访问名称，同一操作能用键盘完成，焦点可见；动效只表达真实状态变化，并支持减少动态效果；不要交付占位、空壳或只靠静态截图证明的界面。
- 代码：复用已有 DTO/VO 和端口；同层用短相对路径，跨层用现有别名，不建桶文件；代码自解释，不写复述实现的注释；单文件超过 1000 行按职责拆分；只在信任边界校验未知输入，失败要明确返回或抛出。
- 测试：领域规则独立测试，应用编排用端口替身，基础设施用集成测试；不要保留源码字符串或导入检查、私有字段检查、简单转发、重复正常路径、只锁文案或实现默认值的测试。
- PR：禁止把大量改动一次性提成 PR；大改动先拆成小 PR，逐个验证和提交。

## 不要提交这些内容

- 密钥、`.env`、模型请求原文或任何凭据
- 用户工程、素材或其他个人数据
- `node_modules/`、`out/`、`dist/`、日志、测试产物和安装包
- 与当前任务无关的顺手格式化或重构

## 许可

本项目采用 Apache-2.0 许可证（详见 `LICENSE`）。提交贡献即视为同意按同一许可证授权。
