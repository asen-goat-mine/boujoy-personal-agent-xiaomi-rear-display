# Boujoy Xiaomi

[English](README.md) · [简体中文](README.zh-CN.md)

在 Mac 上运行私人助理，与小米手机配对。默认操作主屏；支持的设备完成授权后，可使用后台显示和背屏控制。

你可以在聊天里把一件事交给 Boujoy。Mac 上的助理负责分解任务，手机执行操作并返回当前画面；你可以随时查看进度或接手。仓库包含 Mac 服务、Android 客户端、配对中继和本地 Markdown 记忆。

### 第一次可以试什么

> 帮我在购物 App 里找同一件商品的两个选项，对比页面上显示的价格和规格，告诉我在哪里看到的，到结算前停下。

助理可以打开应用、读取连续几个页面，再把结果发回对话。碰到登录或其他需要本人处理的步骤时，你可以直接在手机上接手。不同 App 的界面、已授予的权限和页面可读信息会影响结果。

**设备要求。** 先用主屏完成配对和首次任务。支持的小米设备授权 Shizuku 和 Boujoy 无障碍服务后，可选择后台显示；背屏操作还取决于硬件和系统版本。切换执行模式前，可以在应用内查看设备就绪状态。

## 52 的更新

- 手机上点击发送后，消息立即出现在当前对话底部。回执到达后按 ID 合并；发送失败保留对应对话的草稿。连接栏显示手机实际观测到的状态。
- 读屏仍获取新帧。同次观察中，连续两张截图的完整编码相同就复用成功的本地 OCR 结果，画面变化时重新识别。任务同步只为确实待核实的结果扫描回执。
- 模型请求只发送一次可确认重复的手机截图。相邻同窗口页面可引用完全相同的文本行，两个不同的价格与画面都保留。四张相同截图的合成请求从 405 KB 降至 104 KB；真实任务耗时取决于设备、网络和模型。

## 从源码启动

使用 Apple Silicon Mac、Node.js 24+ 和 Python 3.10+。在仓库根目录执行以下命令。下载的工具和模型服务分别需要网络，模型凭证由使用者配置。

```sh
npm ci
npm run setup
python3 scripts/prepare-phone-use.py --include-apk
npm start
```

打开 `http://127.0.0.1:18892`。在设置中选择手机、配置模型和配对中继；请使用自己的服务器和账号。Android 源码构建命令为 `python3 scripts/build-android.py --test`。运行 `npm test` 和 `node scripts/verify-distribution.mjs` 可检查后端与发行身份。详见[完整构建指南](BUILD.zh-CN.md)。

## 复现请求体积对照

以下命令使用合成画面比较更新前后的请求字节数，全程离线。

```sh
git worktree add --detach ../boujoy-xiaomi-baseline v1.0.52-base
node scripts/bench-model-frame-context.mjs ../boujoy-xiaomi-baseline evidence/vision-fixtures
```

Boujoy 原创代码采用 [MIT 许可证](LICENSE)。依赖、字体、图标和随附源码各自的许可证见[第三方声明](THIRD_PARTY_NOTICES.md)。
