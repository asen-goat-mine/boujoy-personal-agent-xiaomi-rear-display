# Boujoy：Phone Use / Xiaomi 公开版

Boujoy 在 Mac 上运行助理、模型执行引擎与本地 Markdown 记忆，通过配对后的 Android 执行端操作手机。本源码使用 `distribution.json` 选择一个发行版；应用身份、版本、端口和能力均以该文件为准。两个发行版来自同一公共基线，不能通过重命名 `.app` 或替换 APK 文件名切换版本。

当前代码版本见 [distribution.json](distribution.json)，第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目采用 [MIT License](LICENSE)，第三方软件继续使用其各自许可。

## 选择安装路线

- **已经拿到分享包**：阅读包内 `README.md` → `SETUP.md`；Mac 应用已内置后端、Node、Python、Harness 与 Phone Use 客户端，不需要先安装源码开发环境。源码内对应说明见 [接收者配置](docs/share/SETUP.md)。
- **需要修改或自行构建**：使用本仓库或其源码归档，按下文准备开发环境。归档不应包含个人数据目录、模型密钥、签名私钥、配对记录或聊天截图。
- **交给 AI 配置**：使用 [AI-SETUP.md](docs/share/AI-SETUP.md)，先识别当前拿到的是分享包还是源码；不要让 AI 把开发壳当成可搬移的分享包。

## 两个发行版

| 项目 | Phone Use | Xiaomi |
|---|---|---|
| Mac 名称 | Boujoy Phone Use | Boujoy Xiaomi |
| Mac Bundle ID | `dev.boujoy.phoneuse.desktop` | `dev.boujoy.xiaomi.desktop` |
| Android applicationId | `dev.boujoy.phoneuse` | `dev.boujoy.xiaomi` |
| 绑定 scheme | `boujoy-phoneuse` | `boujoy-xiaomi` |
| 本机 UI / API 端口 | `18891` | `18892` |
| 数据目录（Application Support 下） | `Boujoy Phone Use` | `Boujoy Xiaomi` |
| 记忆目录（Documents 下） | `Boujoy-PhoneUse-Memory` | `Boujoy-Xiaomi-Memory` |
| Keychain account / service 前缀 | `boujoy-phoneuse` / `dev.boujoy.phoneuse` | `boujoy-xiaomi` / `dev.boujoy.xiaomi` |
| launchd label | `dev.boujoy.phoneuse.service` | `dev.boujoy.xiaomi.service` |
| 手机执行方式 | 主屏 | 默认主屏；能力就绪后可选后台显示 |

两款应用可以并存，数据、记忆与钥匙串分开，也不会自动读取个人旧版的配置。**同一手机一次只让一个发行版执行任务**：切换前先暂停或结束另一版任务。两版之间没有全局执行租约，不能据此宣称同一手机可同时接受两边操作。官方 Phone Use 是两版都使用的独立第三方组件，可能共用同一手机上的安装。

支持的 Mac 分发目标是 **macOS Apple silicon / arm64**。通用版面向 **Android 13+**，通过实际设备选择与配对接入，不固定品牌、型号或序列号；各品牌的无障碍、电池限制和联网行为仍需实际核验。Xiaomi 版额外使用后台显示和背屏能力探测，不代表所有小米手机均支持，也不代表其他品牌支持背屏。

## 从源码运行

先把源码解压到自己的开发目录；不要把依赖装进个人知识库。需要 Node.js 24+、npm、Python 3.10+；Mac 桌面和官方 Android 引导构建目前以 arm64 macOS 为目标。以下命令均在**源码根目录**执行：

```sh
node --version
python3 --version
npm ci
npm run setup
python3 scripts/prepare-phone-use.py --include-apk
npm test
npm run check
node scripts/verify-distribution.mjs
```

`npm ci`、`npm run setup` 和 Phone Use 准备脚本需要下载依赖。Harness 固定为 `@deepseek-ai/dsh@0.2.1-alpha.2`，源码环境安装在 `.runtime/harness`；Phone Use 1.3.0 的客户端与 APK 下载后验证固定摘要，放入本发行版的数据目录。准备脚本不会安装 APK、配对手机或读取密钥。

若有 `runtime-manifest.json`，源码校验必须通过；若源码有意处于开发中且没有该文件，验证器以 `unsealed` / 退出码 2 明确提示未封版，这不等于发行验收通过。不要通过重新生成清单来掩盖来源不明的文件变更。

```sh
npm start
```

在本版 `distribution.json` 指定的 `http://127.0.0.1:端口` 打开界面。模型凭证在“设置 → 连接 → DeepSeek”中由本人填写；不用命令行传密钥。后台已经运行后，可另开终端运行：

```sh
node scripts/verify-distribution.mjs --running
```

源码开发可通过 `BOUJOY_DATA`、`BOUJOY_MEMORY_VAULT`、`BOUJOY_HARNESS`、`BOUJOY_PYTHON`、`BOUJOY_PORT` 显式指定本人的位置或端口；先查对应源码参数，不把旧个人环境变量带入公开版。自定义端口后使用 `--running --origin http://127.0.0.1:实际端口` 核验。不把本机 UI/API 暴露到公网。

浏览器自动化需要本机可用的 Playwright Chromium 或 Google Chrome。需要下载 Chromium 时，在源码环境执行 `npx playwright install chromium`；应用使用隔离的浏览器资料目录，不复制个人浏览器登录资料。语音是可选能力；当前实现优先调用 DeepSeek 语音服务，音频/朗读文本可能发送到供应商，本机回退需要另行准备。见 [语音说明](docs/local-voice.md)；未准备依赖或未测试时不要宣称可用或全程本地。

### 构建开发用 Mac 应用

按 [desktop/README.md](desktop/README.md) 安装固定 Electron 运行时，再运行：

```sh
npm run app
```

产物位于 `dist/本版产品名.app`。这是依赖当前源码路径和 Node 路径的开发壳，移动源码或修改源码后需要重建。它不是分享包。Mac 应用首次请求录音时由系统授权；窗口关闭后服务可能继续运行，不能把关闭窗口当作后端退出。

可选的源码常驻服务使用 `npm run service:install` / `npm run service:uninstall`。安装前正常停止当前前台进程；脚本会认证并核验现有进程的构建身份，遇到错版或不同源码摘要会拒绝复用，不会为了占用端口自动杀死其他服务。卸载服务不等于删除数据。

### 构建 Android

```sh
python3 scripts/build-android.py --test
```

脚本在本版数据目录的 `build-tools/android` 中准备固定摘要的 JDK、SDK 引导工具、Gradle 和**本人的签名身份**，接受并安装构建需要的 Android SDK 包；它不会安装到手机。也可用 `--runtime /绝对/隔离目录` 指定构建工具与已备份签名身份的所在目录。签名私钥及密码必须保留在本机并备份，不纳入源码或分享包。

正式 APK 在 `android/app/build/outputs/apk/release/app-release.apk`，相邻的 `output-metadata.json` 和 `boujoy-build-report.json` 必须保留。`dist/android/build-report.json` 包含版本、applicationId、APK 摘要以及 Android 全部输入文件摘要。构建前后输入发生变化会拒收。用同一 applicationId 更新安装时必须使用原签名；**签名不匹配立即停止，不卸载旧应用、不清数据来绕过**。先备份并确定迁移方案。

### 制作完整分享包

以下为维护者流程，不是接收者安装步骤。分别在两份干净、独立的源码目录构建各 edition；Android/桌面/数据/Keychain 身份必须与各自 `distribution.json` 一致，不能在已经封版的应用内直接改 edition。

1. 完成源码、文档与第三方许可审查，运行 Node 与 Android 测试；使用本版配置构建 Android。保证后端依赖、固定 Harness、固定 Phone Use 与可搬移 Python 均已准备。
2. 开发改动前，先确认原封版校验通过，并把旧 `runtime-manifest.json` 备份到源码目录之外后移走，明确进入未封版开发状态。保留旧清单时，运行模块会在导入阶段拒绝已经改动的源码，不能直接用下面命令覆盖。完成全部变更、测试和审查后，才从没有旧清单的开发目录生成新清单；不能用此流程掩盖来源不明的损坏：

   ```sh
   node --input-type=module -e 'import fs from "node:fs"; import {runtimeSourceManifest} from "./src/distribution.mjs"; fs.writeFileSync("runtime-manifest.json", JSON.stringify(runtimeSourceManifest(process.cwd()), null, 2) + "\n");'
   node scripts/verify-distribution.mjs
   ```

3. 显式设置打包环境变量后执行 `node scripts/package-share.mjs`。变量值均是本机准备好的实际路径，不包含密钥：

   | 变量 | 必需内容 |
   |---|---|
   | `BOUJOY_FRESH_ANDROID_APK` | 新构建的 release APK，旁边有 metadata 与源码摘要收据 |
   | `BOUJOY_ANDROID_BUILD_TOOLS` | Android SDK build-tools 目录，包含 `aapt2` 与 `apksigner` |
   | `BOUJOY_SHARE_OUTPUT` | 尚不存在的绝对输出目录 |
   | `BOUJOY_SHARE_PYTHON` | 完整、可搬移的 Python 3.12 arm64 目录，包含 `bin/python3` |
   | `BOUJOY_PHONEUSE_DIR` | 可选，固定 Phone Use 1.3.0 的客户端、APK、LICENSE 所在目录 |
   | `BOUJOY_ELECTRON_RUNTIME` | 可选，按 desktop 文档准备的 Electron 目录 |

   未验证 APK 的旁路开关已禁止。打包器核 APK 实际签名、二进制 package/version、收据与当前 Android 全部输入；不会仅凭文件名或修改时间确认新版本。

4. 对输出包执行 `shasum -a 256 -c SHA256SUMS`、Mac 签名核验、内置验证器离线检查，并在可控环境验证真实进程身份。源码归档排除 `.git`、`.runtime`、`node_modules`、`dist`、构建缓存、`.env*`、密钥、签名身份、日志、配对/中继状态与个人数据；按源文件清单导出，不能把用户运行目录整包复制。
5. 保留测试报告、源码清单与 `构建信息.json`。未执行的跨机型、Android 新包名重绑、公网中继部署、麦克风/本机语音和收件人首启均记录“未测试”，以当前发行版的实际记录为准。

`runtime-manifest.json` 覆盖 `src/`、`web/`、`config/`、`distribution.json`、`package.json`、`package-lock.json`；依赖、桌面壳、Android 与文档不在此运行摘要中，因此还需包级 SHA256SUMS、APK 输入收据和完整产物验证。摘要证明文件对应关系，不替代可信来源与签名核验。

## 手机与异地连接

同一局域网可先在 Mac 直接配对官方 Phone Use 并执行主屏任务；手机亮屏解锁，由本人核对首次安全码。这条路线无需先部署云中继。Boujoy Android 聊天端从手机联系 Mac 则需要接收者自建加密 relay：见 [配置步骤](docs/share/SETUP.md) 与 [relay 部署说明](deploy/relay/README.md)。不内置作者服务器、路由凭据或模型账户。

Xiaomi 后台显示默认关闭，需本人启动并授权 Shizuku、开启“Boujoy 后台执行”无障碍服务，并以设备就绪状态为准。后台不可用时暂停任务，不自动切到主屏。背屏、锁屏显示和背屏电源租约分别受系统能力与版本限制；目前电源租约代码还包含严格的型号/系统构建白名单，升级系统后可能拒绝启用，不能把此能力推广为所有小米均可用。

## 验证与排错

[版本与验证](docs/share/版本与验证.md) 区分封版源码一致、实际进程一致与真机功能验收。[排错指南](docs/share/TROUBLESHOOTING.md) 处理错版服务、手机权限、签名冲突与 relay。公开发行版使用独立 Android 包名，接收者须验证本版的实际安装与重绑。实际已执行项目以随产物提供的测试记录为准。
