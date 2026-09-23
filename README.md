# pi-lark-bot

将 [pi](https://github.com/badlogic/pi-mono) 接入飞书 / Lark：用户在私聊中直接发送消息，或在群里 @机器人，即可让 pi 在本机项目中工作。

**一个私聊用户或一个群聊，对应一个独立的 pi 主 agent 会话和 Zellij pane。** 它不是 `subagent`：每个会话都是完整、可在本地交互的 pi TUI，保留自己的历史和模型选择。

> [!WARNING]
> 私聊和群聊都受项目本地用户白名单保护：新用户首次私聊机器人或在群中 @机器人时，会在本机 pi TUI 中弹出确认，默认选中 Confirm，10 秒未确认则拒绝；也可以用 `/lark-bot allow` 手动添加。群聊中未 @机器人的消息会被忽略。请限制应用可用范围，不要把它当作权限沙箱；所有会话共享同一个项目文件。

## 工作方式

收到消息后，扩展会为对应的私聊用户或群聊创建（或复用）一个 Zellij pane，并在其中运行主 pi 会话：

```text
飞书 / Lark 私聊用户 ──┐
                        ├── 独立 pi 会话 + Zellij pane
飞书 / Lark 群聊    ────┘
```

- **私聊**按用户 `open_id` 隔离；**群聊**按 `chat_id` 隔离，同一群成员共享群上下文。两种场景都按发送者 `open_id` 检查白名单，新用户由本机操作者在 10 秒内确认后自动持久化加入；群聊仅处理真正 @机器人的消息。白名单只记录用户，群聊本身不会被整体授权。
- 首条消息创建 pane，后续消息复用；同一会话按 FIFO 执行，不同会话可并行。
- 本地可直接查看 pane、输入消息及处理权限确认；本地输入的回答不会自动转发回飞书/Lark。
- 远程消息通过私有 Unix socket 交给 pi，不会被键入 shell 或终端。私聊会话的 system prompt 会包含其 `user_id`；群聊 system prompt 会包含 `chat_id`，并说明消息采用 `user_id: message` 格式，实际群消息也以此形式提交。
- 工具状态和公开回答草稿会节流更新；完成时以最终回复替换同一条流式消息。不会转发 thinking、工具参数或原始工具输出。

每个会话最多容纳 20 条正在执行或排队的消息，单条消息最多 64 KB。停止监听或主 pi 退出时，pane 与未执行队列都会关闭；下次收到消息会从已保存的历史恢复。

## 要求

- Node.js 22+
- pi 0.85.1+，且已配置模型
- Zellij 0.44+
- 飞书或 Lark 开放平台应用

在 Zellij 中启动 pi（可使用专用 tab 管理机器人会话）：

```sh
zellij
pi
```

## 安装与连接

在扩展目录安装依赖，再将它安装到目标项目：

```sh
cd /path/to/pi-lark-bot
npm install

cd /path/to/project
pi install -l /absolute/path/to/pi-lark-bot
```

若 pi 已经运行，执行 `/reload` 加载扩展。接着在 pi 中：

```text
/lark-bot link
/lark-bot on
```

`link` 可扫描终端显示的官方二维码来创建机器人，也可扫码后在官方页面选择已有机器人连接。连接已有应用时，应用所有者确认后会增量申请本扩展所需的权限和事件；也可以直接输入已有的 App ID / App Secret。

二维码有效期内按 `Esc` 可取消。若二维码在窄终端中换行，请加宽终端；同时显示的页面 URL 也可直接打开。密钥采用隐藏输入，只存于当前项目，不会进入聊天上下文、启动参数或系统钥匙串。

**安装、加载、连接或重启都不会自动开始监听。** 每次要接收消息时，都需显式执行 `/lark-bot on`。

## 开放平台设置

在 [飞书开放平台](https://open.feishu.cn/app) 或 [Lark 开放平台](https://open.larksuite.com/app) 配置应用：

1. 启用机器人能力，发布应用，并限制应用可用范围。
2. 在事件订阅中选择**使用长连接接收事件**，订阅 `im.message.receive_v1`。
3. 开通并完成必要审批/发布的权限：
   - `im:message:send_as_bot`
   - `im:message.p2p_msg:readonly`
   - `im:message.group_at_msg:readonly`
   - `im:message:readonly`（读取被回复的文件消息）
   - `im:message:update`
4. 如果需要聊天中的 `/model` 按钮菜单，在回调订阅中启用 `card.action.trigger`。重新扫码连接已有应用时也会增量申请该回调。
5. 要在群中使用时，将机器人加入群聊。

扩展处理人类用户发来的文本：私聊文本会直接处理；群聊消息必须真正 @当前机器人。@其他用户、@所有人、单独发送的附件消息均不会触发。若文本消息引用/回复了一条文件、图片、音频或视频消息，扩展会在用户授权通过后读取并缓存资源，再把本地路径随指令交给 Pi。单个附件下载失败不会丢弃文本请求，Pi 会收到固定的不可用状态并可继续处理文字。启动时扩展会读取机器人自身的 `open_id`，用于校验 mention 身份。

不要让多个进程同时监听同一个应用——平台会把消息分配给不同长连接，而非向每个连接广播。项目锁仅阻止同一项目中的重复启动。

## 命令

### pi 本地命令

| 命令 | 说明 |
| --- | --- |
| `/lark-bot` | 查看连接、监听、会话和 pane ID |
| `/lark-bot link` | 配置认证；不会开始监听 |
| `/lark-bot on` | 确认风险后开始监听 |
| `/lark-bot off` | 停止监听并关闭本扩展创建的 pane；保留历史 |
| `/lark-bot allow` | 从最近被拒绝的发送者中选择一个加入白名单 |
| `/lark-bot allow <open_id\|授权码>` | 直接按 `open_id` 或授权码加入白名单 |
| `/lark-bot deny <open_id\|授权码>` | 将用户移出白名单 |
| `/lark-bot push` | 查看当前推送目标 |
| `/lark-bot push off` | 清除推送目标，停用推送 |

### 聊天内命令

| 命令 | 说明 |
| --- | --- |
| `/new` | 清除当前私聊用户的会话；在群中仅清除当前群的共享会话 |
| `/model` | 显示可用模型和当前会话模型 |
| `/model provider/model` | 切换当前私聊或群聊会话的模型；保留历史并从下一条消息生效 |

## 白名单与手动授权

白名单只存用户 `open_id`（`allowlist.json`），私聊和群聊共用同一份，群聊不会被整体授权：同一个群里的每个人首次 @机器人都要单独通过一次。

除了 10 秒确认框，还可以由本机操作者手动添加。被拒绝的用户会在聊天里收到一个**授权码**（其 `open_id` 的末 6 位），把它转告操作者即可精确授权：

```text
/lark-bot allow            # 从最近 5 条被拒记录中选择
/lark-bot allow a1b2c3     # 按授权码
/lark-bot allow ou_xxxxx   # 按完整 open_id
/lark-bot deny ou_xxxxx    # 移除，同样支持授权码
```

飞书事件只提供 `open_id`，不含昵称，因此选择列表按"私聊/群聊 · open_id · 授权码 · 消息摘要 · 时间"展示，靠内容和时间认人。这份被拒记录上限 5 条、按用户去重、仅存在内存中，停止监听即清空；白名单本身没有数量上限。

移出白名单不会关闭已经打开的 pane，只影响该用户的下一条消息。未监听时也可以用完整 `open_id` 预先授权（授权码需要监听中才能解析）；若另一个 pi 正持有项目锁，请在那个 pi 里执行。

## 推送目标与主动推送

扩展支持一个**全局唯一、可以为空**的推送目标。为空时推送能力不可用。

设置方式是自然语言：在目标聊天里直接告诉机器人"以后把消息推送到这里"即可。worker 会话的 system prompt 本就带有该会话的 `user_id` 或 `chat_id`，但 `lark_push_target` 工具**不接受任何聊天 ID 参数**——"这里"固定由控制端按该 worker 自己的会话反查，模型无从指定别的聊天，也不会因为抄错 ID 把消息发到别处。

| 工具 | 说明 |
| --- | --- |
| `lark_push` | 向推送目标发送一条消息；未配置目标时失败 |
| `lark_push_target` | `set` 把当前聊天设为目标、`clear` 清除、`status` 查看 |

`lark_push` 在 worker pane 和本机 pi 中行为完全一致，供 skill 在完成某项工作后主动汇报。两者的差别只在实现：worker pane 按设计不持有 bot 凭据，它通过私有 Unix socket 请求控制端代发；本机 pi 就是控制端宿主，直接调用。

**本机 pi 的 `lark_push` 只在监听期间存在**：加载扩展不会注册任何工具，`/lark-bot on` 之后才出现，`/lark-bot off` 或 pi 退出时立即从可用工具集中移除。`lark_push_target` 只在 worker pane 中注册——本机 pi 不属于任何聊天，`set` 在那里没有意义，用 `/lark-bot push` 查看、`/lark-bot push off` 清除。

推送是主动消息，因此有限制：每分钟最多 20 张卡片，单次最多 4 张（约 48 KB），超出部分截断。配额按整条推送预留——若剩余配额放不下这一条的全部卡片，整条会被拒绝，不会只发出一半。推送内容原样发送，不附加来源、项目名或会话标识。推送不是回复，不会关联到任何一条来源消息。目标按 App ID 隔离，更换应用后不会沿用。

## Zellij pane

新会话通过 `action new-pane --near-current-pane` 创建在父 pi 所在 tab，不会抢走键盘焦点。分屏遵循现有 Zellij 布局，不强制方向或等宽；建议保留 `auto_layout true`，由 Zellij 自动调整创建、关闭后的布局。

扩展按精确的 `terminal_<id>` 关闭 pane；创建时直接启动主 pi，不等待 shell 提示符，也不会将远程消息打入 shell。pane 操作位于 `src/zellij.ts`，基于 `pi-interactive-subagents` 的 MIT 代码，仅保留本项目所需部分；不依赖该扩展的安装、工具调用或生命周期。

## 本地存储与安全

扩展在目标项目中保存以下本地状态：

```text
<project>/.pi/lark-bot/
  config.json       # version、brand、appId、appSecret
  sessions/         # 按应用及用户/群键生成确定性的哈希文件名
  seen.json         # 最近 10,000 个已接收消息 ID
  allowlist.json    # 已由本机操作者确认的用户 open_id（私聊与群聊共用）
  push-target.json  # 全局唯一的推送目标聊天；缺失即停用推送
  attachments/      # 被引用附件的持久缓存（按消息资源哈希去重）
  controller.lock   # 项目独占锁
```

状态目录和文件权限分别为 `0700`、`0600`，并会自动写入项目 `.pi/.gitignore`。认证、白名单、附件缓存和会话均为项目本地明文：不要分享或提交它们。模型认证仍使用 pi 自己的配置，且没有全局 bot 认证回退。白名单按当前 App ID 隔离；更换应用后不会沿用。

附件仅在发送者通过白名单检查后下载；同一消息资源会复用缓存。单个资源最大 100 MB，缓存最多约 1 GB；30 天未使用的资源和超出容量时最旧的资源会被清理。文件名会净化，下载采用私有临时文件并原子落盘。当前处理直接引用的独立附件消息，不展开多层引用、富文本内嵌资源或合并转发。若应用是此前连接的，请重新执行 `/lark-bot link` 或在开放平台补充 `im:message:readonly` 权限。

接收去重优先防止重复执行：若进程在记录消息后、执行前崩溃，该消息不会自动重放，需要用户重新发送。若遇到旧锁，请先确认原进程及 pane 已退出，再手动删除 `controller.lock`。

## 开发

```sh
npm run typecheck
npm test
npm run test:integration
npm pack --dry-run
```

集成测试使用独立 Zellij session、最小配置、真实 pi TUI 和本地模拟模型，覆盖工具执行、流式回复、会话隔离、历史恢复、焦点与 pane 清理；不会操作工作 session，也不会消耗付费模型额度。运行需要 Zellij 0.44+ 和 util-linux 的 `script` 命令。

真实租户授权、权限审批和飞书/Lark 客户端显示效果仍须用自己的应用验收。

## 许可证

[MIT](LICENSE)
