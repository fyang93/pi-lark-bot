# pi-lark-bot

把当前项目的 pi 接到飞书 / Lark。**每个私聊用户、每个群聊各有独立的主 agent 会话和 tmux pane**，不是 `subagent`。支持执行进度、回答草稿和最终回复。

这是基础版：**没有用户或群白名单**。能联系机器人、或在群中 @机器人 的人，都能使用运行 pi 的本机工具权限。请用测试应用并限制平台侧的应用可用范围；群成员能看到群内回复。各会话共享项目文件，不是权限沙箱。

## 安装与启用

需要 Node.js 22+、pi 0.85.1+、tmux 3.2+，以及已配置的 pi 模型。

```sh
cd /path/to/pi-lark-bot
npm install

# 在目标项目中安装
cd /path/to/project
pi install -l /absolute/path/to/pi-lark-bot

# 在 tmux 中启动 pi
tmux new -A -s pi
pi
```

已有 pi 会话安装后执行 `/reload`。然后：

```text
/lark-bot connect
/lark-bot start
```

**安装、加载、连接和重启都不会自动监听。** 每次需要手动 `start`。

`connect` 支持官方授权页面创建机器人，或输入已有 App ID / App Secret。密钥隐藏输入，只保存到当前项目，不进入聊天上下文、启动参数或系统钥匙串。授权页面可用 Esc 取消。

## 平台设置

在 [飞书开放平台](https://open.feishu.cn/app) 或 [Lark 开放平台](https://open.larksuite.com/app)：

1. 启用机器人能力，发布应用并设置应用可用范围。
2. 事件订阅选择**使用长连接接收事件**，订阅 `im.message.receive_v1`。
3. 开通以下权限并完成必要的审批/发布：
   - `im:message:send_as_bot`
   - `im:message.p2p_msg:readonly`
   - `im:message.group_at_msg:readonly`
   - `im:message:update`
4. 群聊使用前，把机器人添加到群中。

仅处理人类用户的文本。私聊直接处理；群聊必须真正 @当前机器人，@其他人、@所有人、图片及文件不会触发。启动时读取机器人自身的 open_id，以验证 mention 身份。

不要让多个进程监听同一个应用：平台会在长连接之间分配消息，而不是广播。本扩展的项目锁只防止同一项目内重复启动。

## 命令

| 命令 | 行为 |
| --- | --- |
| `/lark-bot` / `/lark-bot status` | 查看连接、监听、会话与 pane ID |
| `/lark-bot connect` | 配置认证，不启动监听 |
| `/lark-bot start` | 确认风险后开始监听 |
| `/lark-bot stop` | 停止监听，关闭本扩展的 pane，保留历史 |

## 会话行为

- 私聊按用户 open_id 绑定；群聊按 chat_id 绑定，群成员共享该群上下文。不同群、群与私聊互不串用历史。
- 首条消息创建 pane；后续消息复用。同一会话 FIFO，不同会话可并行。
- 运行完整 pi TUI，可在本地查看、输入和处理权限确认。回答结束后保持运行，不注入子代理角色或自动退出机制。
- 远程文本走私有 Unix socket，不通过终端键盘或 shell。私聊原文直接提交；群聊仅用 `user_id: message` 区分发言者，不添加平台介绍。
- 本地正在执行时，远程消息排队；本地发起的输出不自动发回聊天。为保持路由绑定，pane 中禁止切换或 fork 到别的 session。
- 工具名称、执行状态和公开回答草稿节流更新；完成后另发最终回复，长回复分块。不转发 thinking、工具参数或原始工具输出。
- 停止或退出主 pi 后关闭 pane，丢弃尚未执行的队列。重启或 pane 意外退出后，下次消息恢复同一历史。
- 每会话最多 20 条执行/排队消息，单条文本最多 64 KB。

## tmux

`src/tmux.ts` 的 pane 操作直接摘自 `../pi-interactive-subagents/` 的 MIT 实现，仅省略未使用的终端输入、屏幕读取和子代理结束检测：

- `split-window -d -h`，相对父 pi pane 分屏，不抢焦点。
- 创建/关闭后 120ms 防抖执行 `select-layout ... even-horizontal`，**会均衡父 pi 所在整个窗口**；建议使用专用窗口。
- 按 `%pane_id` 精确关闭。

创建后通过 `respawn-pane` 直接启动主 pi，不等待 shell 提示符，也不把远程消息打进 shell。不依赖 `pi-interactive-subagents` 安装、工具调用或生命周期。

## 存储

```text
<project>/.pi/lark-bot/
  config.json       # version、brand、appId、appSecret
  sessions/         # 按应用及用户/群键生成确定性的哈希文件名
  seen.json         # 最近 10,000 个已接收消息 ID
  controller.lock   # 项目独占锁
```

自动添加项目 `.pi/.gitignore`，认证目录/文件权限为 `0700`/`0600`。无全局 bot 认证回退；模型认证仍用 pi 自身配置。会话及认证是本地明文，不应分享或提交。已有配置中的旧白名单字段不再生效。

接收去重优先防止重复执行：进程崩溃时，已记录但尚未执行的消息不会自动重放，需要重新发送。遇到旧锁，先确认原进程及 pane 都已退出，再手动删除 `controller.lock`。

## 开发验证

```sh
npm run typecheck
npm test
npm run test:integration
npm pack --dry-run
```

真实集成测试使用**独立 tmux socket/server 和空配置**，运行真实 pi TUI 与本地模拟模型，验证工具执行、流式回复、会话隔离、历史恢复、布局及 pane 清理。不操作工作窗口、不消耗付费模型额度。

真实租户授权、权限审批和飞书/Lark 客户端显示效果，需要使用自己的应用验收。
