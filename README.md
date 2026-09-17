# pi-lark-bot

将 [pi](https://github.com/badlogic/pi-mono) 接入飞书 / Lark：用户在私聊中直接发送消息，或在群里 @机器人，即可让 pi 在本机项目中工作。

**一个私聊用户或一个群聊，对应一个独立的 pi 主 agent 会话和 tmux pane。** 它不是 `subagent`：每个会话都是完整、可在本地交互的 pi TUI，保留自己的历史和模型选择。

> [!WARNING]
> 私聊和群聊都受项目本地用户白名单保护：新用户首次私聊机器人或在群中 @机器人时，会在本机 pi TUI 中弹出确认，默认选中 Confirm，10 秒未确认则拒绝。群聊中未 @机器人的消息会被忽略。请限制应用可用范围，不要把它当作权限沙箱；所有会话共享同一个项目文件。

## 工作方式

收到消息后，扩展会为对应的私聊用户或群聊创建（或复用）一个 tmux pane，并在其中运行主 pi 会话：

```text
飞书 / Lark 私聊用户 ──┐
                        ├── 独立 pi 会话 + tmux pane
飞书 / Lark 群聊    ────┘
```

- **私聊**按用户 `open_id` 隔离；**群聊**按 `chat_id` 隔离，同一群成员共享群上下文。两种场景都按发送者 `open_id` 检查白名单，新用户由本机操作者在 10 秒内确认后自动持久化加入；群聊仅处理真正 @机器人的消息。
- 首条消息创建 pane，后续消息复用；同一会话按 FIFO 执行，不同会话可并行。
- 本地可直接查看 pane、输入消息及处理权限确认；本地输入的回答不会自动转发回飞书/Lark。
- 远程消息通过私有 Unix socket 交给 pi，不会被键入 shell 或终端。私聊会话的 system prompt 会包含其 `user_id`；群聊 system prompt 会说明消息采用 `user_id: message` 格式，实际群消息也以此形式提交。
- 工具状态和公开回答草稿会节流更新；完成时以最终回复替换同一条流式消息。不会转发 thinking、工具参数或原始工具输出。

每个会话最多容纳 20 条正在执行或排队的消息，单条消息最多 64 KB。停止监听或主 pi 退出时，pane 与未执行队列都会关闭；下次收到消息会从已保存的历史恢复。

## 要求

- Node.js 22+
- pi 0.85.1+，且已配置模型
- tmux 3.2+
- 飞书或 Lark 开放平台应用

建议从专用 tmux 窗口启动 pi，以免调整 pane 布局影响日常工作窗口：

```sh
tmux new -A -s pi
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

### 聊天内命令

| 命令 | 说明 |
| --- | --- |
| `/new` | 清除当前私聊用户的会话；在群中仅清除当前群的共享会话 |
| `/model` | 显示可用模型和当前会话模型 |
| `/model provider/model` | 切换当前私聊或群聊会话的模型；保留历史并从下一条消息生效 |

## tmux pane

新会话会在父 pi pane 的右侧通过 `split-window -d -h` 创建，不会抢走键盘焦点。创建或关闭 pane 后，扩展会以 120 ms 防抖应用 `select-layout ... even-horizontal`，因此会**均衡父 pi 所在整个 tmux 窗口**的 pane。

扩展按精确的 `%pane_id` 关闭 pane；创建后使用 `respawn-pane` 直接启动主 pi，不等待 shell 提示符，也不会将远程消息打入 shell。pane 操作实现基于 `pi-interactive-subagents` 的 MIT 代码，并仅保留本项目所需部分；不依赖该扩展的安装、工具调用或生命周期。

## 本地存储与安全

扩展在目标项目中保存以下本地状态：

```text
<project>/.pi/lark-bot/
  config.json       # version、brand、appId、appSecret
  sessions/         # 按应用及用户/群键生成确定性的哈希文件名
  seen.json         # 最近 10,000 个已接收消息 ID
  allowlist.json    # 已由本机操作者确认的用户 open_id（私聊与群聊共用）
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

集成测试使用独立 tmux socket/server、空配置、真实 pi TUI 和本地模拟模型，覆盖工具执行、流式回复、会话隔离、历史恢复、布局与 pane 清理；不会操作工作窗口，也不会消耗付费模型额度。

真实租户授权、权限审批和飞书/Lark 客户端显示效果仍须用自己的应用验收。

## 许可证

[MIT](LICENSE)
