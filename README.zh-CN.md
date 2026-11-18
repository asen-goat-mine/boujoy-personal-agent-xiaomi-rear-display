# Boujoy Personal Agent（小米背屏显示）

[English](README.md) · [简体中文](README.zh-CN.md)

把查价格、看规格这些来回切页面的活交给助理，主屏留给自己。Mac 负责规划，兼容的小米手机可以在后台显示里执行任务，背屏提供助理入口。先用主屏跑通第一件事，再按设备能力开启后台和背屏，随时都能接手。

## 主屏、后台显示、背屏分别干什么

| 画面 | 你能用它做什么 | 要满足什么条件 |
| --- | --- | --- |
| 主屏 | 看着手机验证助理读到了哪一页、点了哪里，适合第一次配对 | 手机亮屏解锁，Phone Use 已连接 |
| 后台显示 | 让兼容应用在单独的显示空间执行任务，自己继续使用主屏 | 机型与目标应用支持，Shizuku 已授权，Boujoy 后台无障碍服务和执行器就绪 |
| 实体背屏 | 不切回聊天页面，也能瞥一眼任务进度 | 有兼容背屏，系统支持，已打开背屏进度 |

后台显示失去就绪状态时，任务会暂停，由你决定是否改用主屏继续。锁屏显示和背屏电源管理还有各自的机型与系统条件。普通 Android 手机可以选[通用版](https://github.com/asen-goat-mine/boujoy-personal-agent)。

## 看一件任务怎样跑完

> 「帮我看这件商品的两种规格，列出页面显示的价格、每份单价和来源。到结算前停下。」

Mac 上的助理先决定要看什么，手机返回当前画面和可读控件。进入另一款规格后，它会重新观察页面，再把两次看到的数字整理回聊天。你可以逐项核对，也可以中途接手。遇到登录、验证、支付，或应用不向辅助功能提供足够信息时，需要本人处理。

| 还可以怎么问 | 怎么验收 |
| --- | --- |
| 「看看这家店周六的营业时间，跟平日有什么区别？」 | 让助理同时带回页面原文，再看结论。 |
| 「在已打开的会话里拟一句回复，发送前停下。」 | 在手机上核对收件人和草稿，再决定发送。 |
| 「我刚才中途接手了，梳理一下已经做了什么。」 | 对照任务记录、操作回执和当前画面，再决定从哪里继续。 |

## 从源码跑通第一件事：读出手机当前页面

准备 Apple Silicon Mac、Node.js 24+、npm、Python 3.10+ 和 Android 13+ 手机。首次准备工具需要联网，具体耗时取决于下载速度。以下命令从源码运行 Mac 服务。

```sh
git clone https://github.com/asen-goat-mine/boujoy-personal-agent-xiaomi-rear-display.git
cd boujoy-personal-agent-xiaomi-rear-display
npm ci
npm run setup
python3 scripts/prepare-phone-use.py --include-apk
node scripts/verify-distribution.mjs
npm start
```

1. 在 Mac 打开 `http://127.0.0.1:18892`，进入 **设置 → 连接 → DeepSeek**，填入自己的模型密钥。先发一条纯文字任务，确认模型能回复。
2. 在 Android 安装上一步准备的 **PhoneUse-1.3.0.apk**，按界面提示授予无障碍和连接权限。手机亮屏解锁，和 Mac 连到能互相访问的网络。
3. 把 Phone Use 在手机上显示的 HTTPS 地址填进 Mac 的 **设置 → 连接 → 手机**。本人核对两端的八位安全码一致后确认，再选中这台手机。
4. 从 Mac 问「我手机现在打开的页面是什么？」看到与眼前页面相符的回答，再试一下停止按钮。到这里，局域网的第一项手机任务就跑通了。

### 想从手机聊天，再配置异地连接

**Phone Use 执行端**负责操作屏幕，**Boujoy 聊天端**负责发消息、收进度和接手。执行 `python3 scripts/build-android.py --test` 可构建本版聊天端，APK 位于 `android/app/build/outputs/apk/release/app-release.apk`。保留本次签名身份，后续覆盖更新会用到。

在自己的服务器部署加密中继，在 Mac 的 **设置 → 异地连接** 填入 WSS 地址。安装同一发行版的聊天 APK，扫描 Mac 生成的短时绑定码。先在 Wi‑Fi 下试聊天和停止，再切移动网络。异地使用时，Mac 需要保持唤醒并联网。[中继部署](deploy/relay/README.md) · [配对步骤](docs/share/SETUP.md)

## 任务、记忆和模型请求分别在哪里

| 组件 | 职责 |
| --- | --- |
| Mac 服务 | 运行 DeepSeek Harness，协调工具，保存任务历史和本地 Markdown 记忆。模型凭证进入该发行版的 macOS 钥匙串。 |
| Android | 返回当前设备画面，执行支持的操作。Boujoy 聊天端负责消息、进度和接手控制。 |
| 自建中继 | 异地使用时转发设备间的加密流量。配对、撤销绑定和服务器都由使用者管理。 |
| 模型供应商 | 授权使用模型后，处理该次请求所需的上下文，其中可能有文字和截图。记忆是否在本地保存与是否授权模型处理分别设置。 |

## 这次 52 更新解决了什么

- **发消息不必等同步。** 点击发送后，气泡立即出现在当前会话底部；回执按消息 ID 合并，失败时草稿回到原对话。
- **同一画面少做一次识别。** 手机仍会采集新帧；同次观察中，两帧完整编码相同时复用成功的本地 OCR 结果。画面改变就重新识别。
- **给模型少传重复截图。** 同一请求中的重复画面可引用一份原图，不同价格、不同截图和每步回执仍可区分。在四张相同截图的合成回放里，请求体由 **405 KB 降到 104 KB**。真实任务耗时还取决于应用、网络和模型。

## 常见问题

| 看到的情况 | 先核对什么 |
| --- | --- |
| Mac 找不到手机 | 打开 Phone Use 看当前 HTTPS 地址，确认同网、访客网络未隔离、无障碍权限仍有效。 |
| 手机聊天提示电脑离线 | 检查 Mac 唤醒状态、服务是否运行，以及到中继的数据与控制两条连接。 |
| 安装提示签名冲突 | 核对现有应用的包名和签名来源，先备份，再决定迁移方式。 |

[详细排错](docs/share/TROUBLESHOOTING.md) · [完整构建与打包指南](BUILD.zh-CN.md)

## 想读源码，从哪里开始

`src/core/` 是任务引擎，`src/adapters/` 连接手机和其他工具，`src/remote/` 处理远程连接与配对，`android/app/` 是 Android 应用。两个发行版的身份和能力标记在 `distribution.json`。后端回归用 `npm test`，项目检查用 `npm run check`。

## 复现请求体积对照

以下命令使用合成画面比较更新前后的请求字节数，全程离线。

```sh
git worktree add --detach ../boujoy-xiaomi-baseline v1.0.52-base
node scripts/bench-model-frame-context.mjs ../boujoy-xiaomi-baseline evidence/vision-fixtures
```

Boujoy 原创代码采用 [MIT 许可证](LICENSE)。依赖、字体、图标和随附源码各自的许可证见[第三方声明](THIRD_PARTY_NOTICES.md)。
