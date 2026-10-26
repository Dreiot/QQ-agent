# 真实协议端 ZIP 接入验证

2026-10-24。本记录接续合成包测试；按用户要求下载并运行官方完整发行包。两家“原样放入 ZIP → 自动识别 → 自动解压 → 进程启动 → 用户首次登录/确认 → 真实 OneBot 连接”均已通过。没有运行模型生成或主动向真实 QQ 会话发送测试消息。

## 下载校验

| 项目 | 官方正式完整包 | 大小（字节） | SHA256 |
| --- | --- | ---: | --- |
| NapCat v4.18.41 | `NapCat.Shell.Windows.Node.zip` | 124089498 | `51fbb10e7bcd56b0c2a6de86c37811e7518330e48a137ac689ab1e4d8627d3f0` |
| SnowLuma v2.1.1 | `SnowLuma-v2.1.1-win-x64.zip` | 42694125 | `c739171f95c27706767e69ba36099707c222fcec639b46f4d59689997b527772` |

大小及哈希均与 GitHub Releases API 的当前资产元数据一致。官方资产来源：

- https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.41
- https://github.com/SnowLuma/SnowLuma/releases/tag/v2.1.1

网络不稳定，使用官方重定向的 release-assets.githubusercontent.com 分段续传。NapCat 首次合并未通过校验；定位并重取两个受影响分段后，完整 SHA256 通过，才将文件复制到 `protocols/`。没有执行不匹配的文件，也没有使用第三方镜像。

## 当前实测结果

| 阶段 | SnowLuma | NapCat |
| --- | --- | --- |
| ZIP 原样放入 `protocols/` | 已完成 | 已完成 |
| 目录事件自动发现完整包 | 设置页与 API 均已确认，无手工刷新 | 设置页与 API 均确认，无手工扫描 |
| QQ-Agent 自动解压 | 已完成，缓存保留原 ZIP | 已完成，缓存保留原 ZIP |
| 运行官方包内 Node 与入口 | PID 188168，缓存内 `node.exe index.mjs`，实际工作进程 PID 212600 | 首次 PID 208880，重启 PID 209276，缓存内 `node.exe index.js` |
| 原生 WebUI | 已打开 `http://127.0.0.1:5099/` | 已打开 `http://[::1]:6099/webui/` |
| 首次登录、协议确认、改密、QQ 接入 | 用户自行完成，真实桌面 QQ 已接入 | 用户输入 WebUI 登录密钥并扫码完成 |
| 真实 OneBot 与账号身份确认 | HTTP 返回 `status:ok/retcode:0`；WS 自动连接，QQ-Agent `transportReady:true`，身份一致 | HTTP 返回 `status:ok/retcode:0`；WS 自动连接，QQ-Agent `transportReady:true`，身份一致 |
| 实际停止 | 父子进程退出，5099/21117/21118 均释放，原桌面 QQ 保持运行 | 旧 PID 退出，6099/17285/17286 均释放，原桌面 QQ 保持运行 |
| 再次启动 | 本轮未追加验证 | 同一缓存目录，解压标记与 Node 文件时间和大小未变；自动登录已有账号，无需重新扫码，连接再次通过 |

SnowLuma 的 QQ-Agent 连接从 QA 模拟服务 `11293` 切换到真实 HTTP `21117` 与 WS `21118`。NapCat 首次为 HTTP `17285`、WS `17286`，重启后为 HTTP `36470`、WS `36471`。两家的 HTTP `get_login_info` 与 QQ-Agent 经 WS 验证的账号分别一致；初始 QA“已连接”没有作为真实连接证据。

两家首次登录前均返回过连接拒绝；用户完成接入、服务实际开始监听后，QQ-Agent 的原有重连逻辑自动恢复，没有手工重填端口或令牌。重连使用指数退避，首次上线可能等待最多剩余 30 秒，此轮没有修改重连策略。

SnowLuma 页面只有一个“输入访问令牌”字段，实际提交 WebUI 密码，没有用户名输入框。用户从 QQ-Agent 的“启动输出”读取初始 WebUI 密码，然后自行完成登录、确认、改密与桌面 QQ 接入。NapCat 同样由用户读取启动输出中的 WebUI 密钥并完成扫码。凭据没有写入本记录或聊天。

原始 OneBot 设置已备份到被忽略的本机验收目录。最终保留 NapCat 运行、SnowLuma 停止，自动回复保持全局暂停，自启动未开启；不把用户已有桌面 QQ 纳入托管进程。两个原 ZIP 运行后哈希仍匹配，受 Git 忽略与打包排除规则约束。

## 本机证据

`.qa-local/protocol-real-20261024/` 中保留下载元数据、校验结果、状态快照和截图，关键文件为 `snowluma-connected.json`、`snowluma-stop.json`、`napcat-connected.json`、`napcat-stop.json`、`napcat-restarted-connected.json` 和 `napcat-cache-reused.json`。私密备份、真实账号状态快照与初始启动输出不应进入版本库或外部报告。

验证范围为当前 Windows x64 和上述固定版本的本机接入流程。长期稳定性、额外账号/版本/系统及真实消息收发不包含在本轮结果内。
