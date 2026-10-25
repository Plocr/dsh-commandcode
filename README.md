# Command Code for DSH｜订阅接入

[![Release](https://img.shields.io/github/v/release/Plocr/dsh-commandcode)](https://github.com/Plocr/dsh-commandcode/releases)
[![dsh-market 收录](https://img.shields.io/badge/dsh--market-已收录-4D6BFE)](https://dshmarket.com/p/Plocr/dsh-commandcode-goat/)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933)](package.json)
[![MIT](https://img.shields.io/github/license/Plocr/dsh-commandcode)](LICENSE)

**一把订阅密钥，在 DeepSeek Harness 中管理模型、用量和联网搜索。**

Command Code for DSH 将 **Command Code 的 Go / GOAT / Pro / Max 订阅**接入 DeepSeek Harness（dsh），自动同步可用模型，支持收藏筛选、推理预设和额度提醒。

对外名称为 **Command Code for DSH｜订阅接入**。仓库名为 `dsh-commandcode`；为兼容已有安装，包名与配置标识继续使用 `dsh-commandcode-goat`。插件支持全部四个套餐。

插件将模型发布到官方 `llm-pi-ai` 供应商配置中，流式响应、工具调用、图片与历史重放由 dsh 自带的模型适配器处理。

**[市场收录页面](https://dshmarket.com/p/Plocr/dsh-commandcode-goat/) · [最新版下载](https://github.com/Plocr/dsh-commandcode/releases/latest) · [反馈问题](https://github.com/Plocr/dsh-commandcode/issues)**

## 快速开始

### 1. 安装

在 dsh 的「插件 → 添加插件」中粘贴：

```text
github:Plocr/dsh-commandcode
```

也可以安装 Release 包：

```text
https://github.com/Plocr/dsh-commandcode/releases/latest/download/dsh-commandcode-goat.tgz
```

命令行安装到 Web profile：

```sh
dsh plugin --profile web add github:Plocr/dsh-commandcode
```

桌面端请优先使用插件面板。命令行安装时，应选用桌面端实际使用的 profile 和 DSH_HOME，避免装进另一份配置。

仓库已由 `dsh-commandcode-goat` 更名为 `dsh-commandcode`。以下市场链接仍使用原收录地址，待市场同步。

本插件已被 [dsh-market](https://dshmarket.com/p/Plocr/dsh-commandcode-goat/) 收录，也可在已安装的市场中搜索 `dsh-commandcode-goat`。dsh 0.2.1 的「插件 → 发现 → 索引源」可添加以下社区索引后搜索安装（[市场说明](https://dshmarket.com/zh/)）：

```text
https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json
```

### 2. 选择套餐并同步

安装后按宿主提示重启。默认开启自动同步，加载后等待约十几秒，供应商会出现在「设置 → 模型」。

打开「插件 → 已安装 → dsh-commandcode-goat」的配置页，选择与你账户一致的 `Go`、`GOAT`、`Pro` 或 `Max`，点击「创建 / 更新」。默认选择 `GOAT`；读取账户订阅后会提示档位差异，但不会自动替你切换。

0.8.0 的手动更新先展示新增、移除和更新预览，点击「确认应用」才写入。模型管理中可收藏、隐藏模型，开启「仅同步收藏」，并逐模型设置推理预设、窗口和输出上限。自动同步仍按已保存的选择定时执行；需要完全手动确认时关闭自动同步。

配置页分为「概览 / 模型 / 用量与提醒 / 设置」：首页只展示套餐与同步；诊断、提醒阈值、配置迁移和上下文参数按需展开。

### 3. 配置密钥并选择模型

在「设置 → 模型」中找到生成的 `Command | <档位>` 供应商，填写 Command Code API Key 并保存，然后在会话中选择模型。

也可以在启动 dsh 前设置环境变量，例如 PowerShell：

```powershell
$env:COMMANDCODE_API_KEY = '你的 Command Code API Key'
dsh web
```

聊天、账户用量和可选搜索默认共用该凭据。需要使用其他凭据引用时，修改 `targetApiKeyEnv`。

## 功能

| 功能 | 行为 |
|---|---|
| 模型同步 | 合并网关实时模型列表与套餐能力目录，按档位筛选并生成供应商 |
| 协议分流 | 根据模型支持的端点选择 OpenAI Chat、Anthropic Messages 或 OpenAI Responses |
| 同步预览 | 确认前展示新增、移除与能力变化；配置或目录变化后拒绝过期预览 |
| 自选模型 | 收藏、隐藏、仅同步收藏；支持逐模型窗口、输出上限和推理预设 |
| 调用诊断 | 显式选择已发布模型，分别测试连接、流式响应或工具调用；支持取消 |
| 账户用量 | 展示账户、组织、生效订阅、5 小时与每周窗口、余额及请求和 Token 汇总 |
| 额度提醒 | 可选后台每分钟检查用量窗口和余额，跨阈值时记录通知，避免重复提醒 |
| 模型通知 | 同步后记录模型新增、移除、能力及名称优惠标记变化，支持已读与清空 |
| 配置迁移 | JSON 导出、合并或替换导入，先校验和预览；排除凭据、接口与请求头 |
| 联网搜索 | 可选用 Command Code 账户提供 `web_search`，默认关闭 |
| 用量工具 | 默认注册 `commandcode_usage`，让模型读取账户用量 |
| 长会话恢复 | 在高上下文压力时尝试剪枝；对特定网关拒绝尝试减少上下文后重试 |
| 档位清理 | 手动同步后可清理旧档位的生成路由，并提示仍在引用它们的配置 |

每次主动诊断发送 1 次真实模型请求，可能计入账户用量。工具诊断只检查模型返回的工具调用，不执行工具。普通同步和后台同步不自动发起模型诊断；诊断成功也不代表所有模型或长会话已验证。

## 界面预览

**0.8.0 分区首页**（隔离 Web profile、本地模拟模型数据）：

![0.8.0 分区首页](assets/settings-overview-0.8.0.png)

**同步预览**：

![0.8.0 同步预览](assets/sync-preview-0.8.0.png)

**模型管理**（英文推理选项；长列表内部滚动、固定表头）：

![0.8.0 模型管理](assets/model-management-0.8.0.png)

**用量与提醒**：

![0.8.0 用量与提醒](assets/account-usage-0.8.0.png)

**设置**（高级功能按需展开）：

![0.8.0 设置](assets/settings-options-0.8.0.png)

<details>
<summary>历史截图：模型供应商与旧版插件入口</summary>

以下为 0.7.5 历史界面，账户信息已打码。

![生成的供应商](assets/generated-providers.png)

![插件入口（旧版宿主）](assets/plugins-panel.png)

</details>

## 模型与同步规则

模型列表来自 `https://api.commandcode.ai/provider/v1/models`；能力与套餐信息来自 Command Code 套餐文档页。模型数量、价格和账户额度会变化，以同步结果、账户用量及官方套餐页为准。

| 通道 | 供应商 key | 显示名 |
|---|---|---|
| OpenAI Chat | `commandcode-<档位>-autosync` | `Command \| <档位>` |
| Anthropic Messages | `commandcode-<档位>-anthropic` | `Command \| <档位> · Claude` |
| OpenAI Responses | `commandcode-<档位>-responses` | `Command \| <档位> · Responses` |

- 一条供应商路由对应一种协议；同一套餐出现多条供应商是正常现象。
- 只有分配到模型的通道才会创建。模型同时支持 Chat 和 Responses 时优先使用 Chat，因此没有 Responses 路由也可能正常。
- 能力目录失败时优先使用同源的最后成功快照；无快照时仅保留已知或明确添加的模型及既有能力。首次没有可信目录则停止创建，避免误发布高档位模型。实时模型列表失败则停止同步。
- 默认启动后自动同步，并每 6 小时刷新一次。后台同步不删除旧档位路由。
- 关闭或卸载插件后会清理生成的供应商，模型不再继续列出。清理前将路由配置备份到当前 profile 配置文件旁的 `*.commandcode-goat-backup.json`；重新启用时先恢复，因此关闭自动同步也能恢复原配置。账户密钥与其他供应商不受影响。备份可能包含你自定义的请求头，请像配置文件一样妥善保管。
- 手动「创建 / 更新」后默认清理其他档位的生成路由。带非空 `modelOverrides` 的路由会被保留并报告；可用 `pruneOtherPlans: false` 关闭清理。
- 同步将当前模型字段与上次生成基线比较，保留明确的窗口、输入、输出上限、推理和兼容设置修改；模型管理中的明确覆盖优先。隐藏模型才会持续排除，直接删除生成列表中的一项仍可能在下次目录同步中重新发现。
- 已有的凭据引用、协议和非空兼容设置通常会保留。插件会刷新自己生成的显示名，并修正 Claude 路由末尾多余的 `/v1`，避免请求变成 `/v1/v1/messages`。

自定义供应商在新宿主中无法自动继承内置目录的推理能力。对目录声明支持推理的模型，默认写入 `off/medium`；`includeReasoningEfforts` 开启后提供 `off/low/medium/high`。这些值是协议惯例，未经逐模型网关验证。逐模型支持默认、关闭、均衡、深入和自定义映射，不再统一写入 `xhigh/max`。

## 常用配置

在插件配置页修改即可。完整字段及默认值见 [配置定义](lib/index.js)。

| 配置 | 默认值 | 说明 |
|---|---|---|
| `plan` | `goat` | `go` / `goat` / `pro` / `max` |
| `autoSync` | `true` | 启动后自动创建并定时刷新模型 |
| `autoSyncIntervalMs` | `21600000` | 同步间隔，单位毫秒，最小 60 秒 |
| `targetApiKeyEnv` | `COMMANDCODE_API_KEY` | 凭据引用名；配置为空时使用该默认值 |
| `pruneOtherPlans` | `true` | 手动同步后清理旧档位生成路由 |
| `webSearch` | `false` | 使用 Command Code 提供联网搜索 |
| `enableUsageTool` | `true` | 注册 `commandcode_usage` |
| `includeReasoningEfforts` | `false` | 为推理模型生成档位映射 |
| `modelPreferences` | `{}` | 按模型 ID 保存收藏、隐藏、推理预设及能力覆盖 |
| `onlyFavorites` | `false` | 仅发布已收藏且未隐藏的模型 |
| `alertThresholds` | 关闭；80% / 80% / $5 | 用量窗口及余额提醒阈值 |
| `modelChangeNotifications` | `true` | 记录后续成功同步的模型变化 |
| `recoverUpstreamOverflow` | `true` | 特定网关拒绝后的上下文恢复与重试 |
| `contextGuardRatio` | `0.7` | 请求前剪枝的压力比例；`0` 关闭该保护 |
| `maxContextWindow` | `0` | 写入模型的窗口上限；`0` 保留上游声明 |

高级配置还包括 `sourceURL`、`catalogURL`、`targetBaseURL`、`targetCompat`、`extraIds`、`usageBaseURL` 和 `enableBridge`。

开启搜索后，插件会选择 Command Code 搜索供应商；关闭或卸载时，若搜索选择仍由本插件持有，则恢复此前的供应商。用量与搜索请求在宿主侧使用凭据，配置卡片不接收密钥内容。

## 常见问题

**安装后没有出现供应商？**

确认安装到了当前 profile，按提示重启并等待首次同步。打开插件配置页查看错误：`fetch-failed` 通常表示模型源读取失败；`provider-plugin-missing` 表示当前 profile 未加载官方 `llm-pi-ai`；关闭自动同步时需要手动点击「创建 / 更新」。

**Claude 返回 404？**

先更新到 v0.7.9 或更新版本，再同步一次。插件会修正旧配置的 Anthropic 基地址；Claude 客户端自行追加 `/v1/messages`，基地址末尾不应再带 `/v1`。同时检查探测结果与自定义网关地址。

**同步成功，模型调用仍失败？**

配置写入和实际调用是两件事。在「调用诊断」中选择已发布模型和诊断类型，并核对 API key、所选套餐和网络。单个模型成功也不能证明所有模型都可调用。

**切换套餐后旧供应商还在？**

执行一次手动同步，或使用配置页的清理操作。后台同步不清理；带 `modelOverrides` 的路由会受到保护。清理后如有默认模型或子代理仍引用旧路由，请一并调整。

**配置页报「this endpoint answers loopback requests only」？**

配置页的用量、同步预览、诊断和清理都走宿主桥接接口。旧版本这些接口只接受 loopback 请求，因此通过 nginx 等反向代理、隧道或局域网域名打开 dsh web 时，接口返回 403，配置页只剩报错。现在这些接口采用宿主自己的 `/api` 判定：本机、启动参数 `--trusted-host` 声明的域名、监听地址，并且需要宿主的浏览器登录态。反代部署只需在启动 dsh 时声明对外域名：

```sh
dsh web --public-url https://dsh.example.org/ --trusted-host dsh.example.org
```

未声明的域名仍然拒绝（防 DNS rebinding 与跨站请求）；宿主没有该判定服务时（较旧版本），接口仍按 loopback 判断，行为与本版之前一致。

**更新 dsh 后需要改插件吗？**

0.8.0 的验收基线为 dsh 0.2.1-rc.2：已在隔离 Web profile 中验证加载、新界面和启停清理。旧版宿主不在本版实机验收范围内；dsh 0.1.6 用户应继续使用插件 0.4.8。真实付费模型调用与长会话效果尚未验收。

该宿主的热重载事务会阻止卸载期间直接写设置；本版使用运行时检测的事务退出兼容处理，再排队清理。这个处理依赖宿主内部实现，后续 dsh 更新需要复验。正常禁用会备份并移除本实例生成路由；强杀进程或只读配置无法保证清理完成，失败时保留恢复数据。备份恢复成功后会消费，避免再次复活主动删除的路由。

**长会话保护是否保证不超限？**

不保证。插件依赖宿主提供的计量、剪枝和压缩服务，只对自己生成的路由生效。默认保留上游窗口声明；自定义压缩策略、网关限制和模型行为都会影响结果。

## v0.8.0 更新

- 新增同步预览、收藏/隐藏/仅同步收藏、逐模型推理与能力覆盖。
- 新增连接/流式/工具诊断、额度提醒、模型变化通知、配置导出与恢复。
- 修复停用残留模型、过期备份复活路由、跨实例误清理及同套餐空通道残留。
- 修复目录失败导致能力降级、协议冲突、窗口验证、用量解析与账户切换、搜索取消及迟到界面写入。
- 多账户管理不在本版新增范围。完整执行与验收记录见 [IMPLEMENTATION_0.8.0.md](IMPLEMENTATION_0.8.0.md)。

### v0.7.9

- 修复 Claude 路由重复 `/v1` 导致的 404，并在同步时修正旧配置。
- 同步后展示通道请求的状态、耗时和错误信息。
- 解释通道缺失原因，区分套餐筛选、端点支持与协议优先级。
- 包含 v0.7.6–v0.7.7 的上下文保护、同步原子性、取消处理和配置卡片改进。

完整版本记录与安装包见 [Releases](https://github.com/Plocr/dsh-commandcode/releases)。

## 开发

需要 Node.js 20 或更新版本，无额外构建步骤。

```sh
npm install
npm test
```

客户端 `lib/client.js` 是直接维护的无构建模块；修改时同时运行前端契约测试并在真实宿主浏览器验收。`npm test` 包含审查回归、领域逻辑与宿主/客户端契约；模拟请求不等同于真实网关调用。真实服务验证脚本为 `npm run verify:live`，需要相应凭据和网络，可能产生调用费用。仓库不跟踪 `package-lock.json`，安装使用声明的依赖范围。

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 宿主装配、同步与工具注册 |
| `lib/catalog.js` / `lib/plans.js` | 模型目录、档位与通道路由 |
| `lib/pi-ai.js` | 官方供应商配置的写入与清理 |
| `lib/probe.js` | 通道调用诊断 |
| `lib/recovery.js` | 上下文保护与失败恢复 |
| `lib/usage.js` / `lib/search.js` | 账户用量与搜索 |
| `lib/bridge.js` / `lib/client.js` | 宿主接口与设置卡片 |

## English

**Command Code for DSH** connects a Command Code **Go / GOAT / Pro / Max** subscription to DeepSeek Harness. Manage models, reasoning presets, quota alerts and web search with one subscription key. The plugin publishes provider profiles to the official `llm-pi-ai` adapter. The installation identifier remains `dsh-commandcode-goat` for compatibility.

```sh
dsh plugin --profile web add github:Plocr/dsh-commandcode
```

Restart the profile when prompted, select your subscription tier, and configure `COMMANDCODE_API_KEY` under **Settings → Models** or in the environment. Version 0.8.0 adds sync previews, favorites/hidden models, per-model reasoning presets, explicit diagnostics, quota/model notifications and portable configuration import/export. Automatic sync is enabled by default and follows saved preferences. Diagnostics are explicit, may consume quota, and never execute returned tools. Multi-account management is deferred.

Listed on [dsh-market](https://dshmarket.com/p/Plocr/dsh-commandcode-goat/). Download the latest package and read release notes on [GitHub Releases](https://github.com/Plocr/dsh-commandcode/releases/latest).

## License

[MIT](LICENSE)
