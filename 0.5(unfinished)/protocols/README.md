# 放入你自行下载的协议端

QQ-Agent 只提供本地识别、启动与 OneBot 连接适配，不附带、下载或再分发第三方协议端及 QQ 客户端。

1. 从项目自己的 GitHub Releases 下载完整发行包。
2. 把 ZIP 原样放在本目录，或把解压后的整个文件夹放在这里。保留完整目录结构，不要只复制启动文件。
3. 打开 QQ-Agent「设置 → QQ 连接 → 添加 QQ」，选择「Snowluma」或「Napcat」。窗口会自动识别放入的发行包；出现包名后点击「继续连接」。ZIP 会在 QQ-Agent 数据目录中自动解压，原 ZIP 保留，无需手动刷新。
4. 按窗口提示完成账号选择或扫码；协议端的首次协议确认、密码设置仍需你亲自完成。「启动时恢复连接」开启后，下次启动 QQ-Agent 会恢复已勾选的账号。

SnowLuma 首次启动后，「连接 QQ」窗口会显示「复制初始密码」。点击即可复制本次启动输出中的随机密码，再打开 SnowLuma 完成首次确认和改密。修改密码后该按钮自动隐藏；后续连接使用你设置的管理密码。初始密码仅从 QQA 启动的当前进程读取，不会写入 QQA 配置；自行在其它位置启动的 SnowLuma 仍需手动输入。

| 协议端 | 可直接托管的发行包 | 首次使用 |
| --- | --- | --- |
| [NapCat](https://github.com/NapNeko/NapCatQQ/releases) | Windows x64 的 `NapCat.Shell.Windows.Node.zip` | 在其登录页扫码。普通 Shell 包使用上游启动器，或换用完整 Node 包 |
| [SnowLuma](https://github.com/SnowLuma/SnowLuma/releases) | 对应系统架构、包含 Node 的完整 ZIP | 先启动桌面 QQ，再在 SnowLuma 页面完成协议/隐私确认、修改初始密码和 QQ 接入 |

GitHub 的 **Source code** ZIP 是源码，未经构建不能直接启动。SnowLuma Lite 没有自带所需 Node；请选完整发行包。使用条件、系统要求、客户端版本和许可请以各上游说明为准。QQ-Agent 不代替你接受条款，不读取或迁移 QQ 登录态。

此处一次托管一个协议端服务，同一服务可接入多个 QQ，各账号设置独立保存。停止共享服务会断开全部关联账号；单个账号使用账号卡片控制连接。已有其它服务和账号配置会保留，修改前会备份。停止仅结束由当前 QQ-Agent 启动的进程，不会退出你已打开的 QQ。

源码运行时放置目录为项目根目录 `protocols/`；安装版为 QQ-Agent 可执行文件旁的 `protocols/`。可用 `QQ_AGENT_PROTOCOL_DIR` 显式指定其它目录。放置的第三方文件、账号配置及日志均被 Git 和应用打包规则排除。
