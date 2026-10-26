# QQ Agent 0.5（DSH 架构）

QQ Agent 的 DSH 重写版（薄内核 + 全插件外壳）。行为以规格书为验收依据，当前实现和验收边界记录在下方进度文件中。

## 安装与连接

本版本仍在开发和验收中。需要 Node.js 20 或更新版本，并由用户自行准备提供 OneBot v11 正向 WebSocket 事件和 HTTP API 的外部协议端。

```bash
git clone https://github.com/K0nd1us/QQ-agent.git
cd "QQ-agent/0.5(unfinished)"
npm install
npm run desktop
```

无桌面环境时运行 `npm run server`，再打开 `http://127.0.0.1:3210`。

可自行从上游 Releases 下载 [NapCat 完整 Node 包](https://github.com/NapNeko/NapCatQQ/releases) 或 [SnowLuma 完整包](https://github.com/SnowLuma/SnowLuma/releases)，将 ZIP 或完整解压目录放进项目根目录的 [`protocols/`](protocols/README.md)，再到「设置 → QQ 连接」点击“启动并连接”。QQ-Agent 自动检测发行物、解压 ZIP、备份并补齐 OneBot 配置；登录、首次协议确认及客户端接入由你在上游自己的页面完成。只有显式启用“随 QQ-Agent 启动”才会自动启动所选包。安装版放置目录在可执行文件旁，具体包型和前置条件见[放置说明](protocols/README.md)。QQ-Agent 不附带、下载或再分发协议端和 QQ 客户端。

已有自行运行的 OneBot 服务也可继续手动填写 WebSocket 地址、HTTP API 地址和两种访问令牌：`onebot.wsUrl`、`onebot.httpUrl`、`onebot.accessToken`、`onebot.httpAccessToken`。使用条件、许可和客户端版本要求请查阅上游说明。

升级前备份配置和数据，升级后重新填写 OneBot 连接配置。旧版专属运行时配置不自动迁移，已有第三方程序和账号数据不会由本次改动删除。连接后应在测试会话验证所需的收发与媒体行为；自动测试和连接状态不代表真实 QQ 联调已完成。

## 事实来源

- 行为规格：`../dsh-spec/SPEC.md`（§1–§18，F-001~F-223 + §5/§8/§9 三段式契约）
- 结构图纸：`../dsh-spec/DSH-ARCH.md`
- 2026-10-16 追加式组合规格：[默认实现与追加式组合 v2.1](docs/architecture-composition.md)，取代旧版“固定内核/不可替换内核页”的限制。
- 当前进度：`progress.md`
- 有头验收：`docs/headed-qa-checklist.md`、`docs/headed-qa-results.md`
- 回归证据：`docs/headed-qa-regression-evidence.md`
- 追加式组合验收：[实现与回归证据](docs/composition-regression-evidence.md)，[可复制示例](examples/composition/README.md)。
- 部分重叠贡献：[逐目标替换、方法包装与多层撤销验收](docs/composition-overlap-evidence.md)。
- 决策记录：`../dsh-spec/NEXT-SESSION.md` §3（D-1~D-7）

## 外观自定义

界面外观支持在「设置 → 外观 → 点选编辑」中直接调整实际页面，可按单个元素、当前页面或同类组件设置，并自动保存。操作方式见[外观点选编辑](docs/appearance-visual-editor.md)。

## 依靠 AI 添加功能

在技能、插件或社区页打开“创作扩展”，直接复制提示词；也可从[文档版提示词](docs/ai-extension-prompt.md)开始。AI 会先用日常话问清并确认需求，再自行读取[开发文档](docs/extension-authoring.md)、判断做成技能还是插件，完成制作、自检并放入对应文件夹。新功能默认禁用，由你在列表中点击启用；无需选择技术类型或自己运行命令，不会自动上传社区。需要 ZIP 时可另行打包。

开发者可查[完整参考](docs/extension-reference.md)，直接复用[完整范例](examples/extensions/README.md)。提供自检、离线执行和社区同格式打包工具：`npm run extension:check -- <目录>`、`npm run extension:test -- <目录> --case <用例文件>`、`npm run extension:pack -- <目录> --out <ZIP路径>`。Windows 安装版可使用 `scripts\extension-dev.cmd`，复用自带运行时。

0.4 扩展迁移先查[逐项能力对照](docs/v04-extension-parity.md)，不要混用旧日志函数、执行参数顺序或 sender。自检、真实 QQ 联调与生产社区发布分别报告结果；本轮过程见[AI 创作验收](docs/ai-extension-validation.md)。

## 工作约定

1. 用户已授权参考 `../develop/` 的公开源码补齐功能；该目录的私有配置、账号、凭据和日志不属于参考范围。
2. 用户已授权同步修订插件化架构规格。修复应附相关验证，区分产品缺陷、未完成的实测和外部条件不足。
3. 本地测试使用独立合成副本；不得将安装校验、模拟接口或自动测试当作真实账号联调通过。
4. 当前 Git 元数据只读，保留现有变更。安装包打包按用户要求延期，完成测试后再统一安排。

## 状态

- 已实现插件宿主、控制台及桌面界面，正在继续修复和本地有头验收。最新完整回归、实际操作记录和剩余条件以 `progress.md` 及上述验收文件为准。
- 支持检测和启动用户自行放入的两种完整协议端发行包，管理自己启动的进程树；不会分发第三方运行时、接管已运行的外部进程或迁移 QQ 登录态。真实 QQ 登录与收发联调仍须使用用户自己的账号完成。
