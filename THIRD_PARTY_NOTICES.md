# 第三方组件说明 / Third-party notices

Boujoy 本身以 MIT 许可证发布（见 [LICENSE](LICENSE)）。第三方组件以各自的许可证提供。下文区分原包附带的许可、补充的来源证据和安装时下载的依赖；不以此清单替代各组件的许可条款。

## 随仓库附带的源码

| 组件 | 位置 | 许可证 |
| --- | --- | --- |
| DeepSeek Super-agent 原型（deepseek-ai/dsh-superagent-prototype，提交 `8c32a9d`） | `vendor/dsh-superagent/`，构建产物在 `src/vendor/dsh-superagent-core.mjs` | MIT，Copyright (c) 2026 DeepSeek Harness Team，原文见 `vendor/dsh-superagent/LICENSE`、`src/vendor/dsh-superagent-LICENSE` |
| Lucide 图标 | `web/icons/`（来自 `lucide-static`） | ISC，见 `docs/licenses/lucide.txt` |
| Fusion Pixel 12px Monospaced zh-Hans 字体（2026.11.10） | `android/app/src/main/res/font/fusion_pixel_12.otf` | SIL OFL 1.1；Copyright (c) 2022 TakWolf。原始字体及 Ark Pixel、Cubic 11、Galmuri 通知见 [字体来源与许可](docs/licenses/fusion-pixel/README.md)，Android APK 内也保留 `assets/font-licenses/fusion-pixel/` |

## 安装时下载的依赖

- **DeepSeek Harness**（npm `@deepseek-ai/dsh` 0.2.1-alpha.2）：MIT。运行 `npm run setup` 时安装到 `.runtime/harness`；本仓库不附带它的代码。
- **npm 依赖**：安装版本及完整依赖关系见 `package-lock.json`。各包的许可字段和随包通知分别适用；不能仅根据锁文件将全部依赖概括为同一种许可政策。`jszip` 的双许可选择为 MIT；`pako` 保留其 MIT 与 Zlib 通知。
- **buffers 0.1.1**：npm 发布包未附独立许可文件，也未填写许可字段；原作者 James Halliday 的 [许可提交 `1b745ee35d33eb166e15ef1866073a07c6d7de87`](https://github.com/bitpay/node-buffers/commit/1b745ee35d33eb166e15ef1866073a07c6d7de87) 明确声明 MIT/X11。该提交的 `index.js` 与本项目实际安装版本逐字节一致，证据和补附的标准 MIT 文本见 [buffers 许可说明](docs/licenses/buffers-NOTICE.md)。
- **Electron**（桌面 App 运行时）：MIT。
- **Android 构建工具**（JDK、Android SDK、Gradle）：由 `scripts/build-android.py` 下载固定版本并校验哈希，各自的许可证由上游提供。

## Android 应用内的运行依赖

Shizuku api/provider/aidl/shared 13.1.5 使用 MIT；AndroidX Annotation、OkHttp、Okio、Kotlin 标准库与 JetBrains annotations 使用 Apache 2.0。OkHttp 内含的 Public Suffix 数据另适用 MPL 2.0，不能只按 OkHttp 的 Apache 2.0 许可概括。完整文本、原始数据、固定版本来源与哈希见 [Android 运行依赖许可](docs/licenses/android-dependencies/README.md)，并包含在 APK 的 `assets/third-party-licenses/`。文本保持原字节；AAPT 会将该目录下的 `.gz` 数据资产解压并去除扩展名，OkHttp 自身的运行资源仍保留原 gzip 字节。

## 不随仓库提供的组件

- **Phone Use**（Android 无障碍执行组件，包名 `ai.nidhoggfgg.phoneuse`）：这是第三方软件，本仓库不包含它的 APK 或源码。请从它的官方渠道获取，并遵守它的许可证。Releases 里的安装包如果附带了它，会把它的 LICENSE 一起放在包里。
- **Bok 个人记忆核心**（`vendor/bok_personal/`）：可选组件，不在本仓库中。没有它时，Boujoy 只使用 Markdown 记忆。

## 桌面 Harness 的原生图像依赖

桌面分享包内 `@img/sharp-libvips-darwin-arm64` 1.3.4（libvips 8.18.7）及其组成库保留各自的 LGPLv3、MPL 1.1、MIT、BSD、FreeType/IJG 等许可和署名。完整 LGPL/GPL 文本、逐项原始通知、实际附带的 28 项固定版本官方源码归档与校验哈希、上游补丁和动态替换说明见 [sharp/libvips 许可与源码来源](docs/licenses/sharp-libvips/README.md)。这些第三方许可与 Boujoy 自有代码许可分别适用。

## 便携 Python 及其原生依赖

分享包内的 CPython 3.12.14、OpenSSL、SQLite、Expat、bzip2、liblzma、libffi、mpdecimal、libuuid，以及 Tcl/Tk/Itcl/Thread 分别适用各自许可。已按实际 Mach-O 区段和官方固定发行元数据核对来源，原版许可集合、Tcl 数据来源及组件说明见 [便携 Python 许可](docs/licenses/python-runtime/README.md)。不将 CPython 的许可证概括为所有原生依赖的许可证；macOS 系统动态库不随包复制。便携基础解释器不包含 pip/ensurepip 或 site-packages。

## 其他桌面原生扩展

Canvas 1.0.11 的随包 SBOM、Skia/Cargo 依赖原始通知与四项 MPL 完整源码，以及 Koffi 3.1.1 的 MIT/Unicode 通知，见 [原生扩展索引](docs/licenses/native-addons/README.md)。Sherpa-ONNX 1.13.8 的实际预编译库包含 GPLv3 eSpeak；不能仅用其 npm Apache 许可字段概括。原始文本、固定源码与构建配方见 [Sherpa 说明](docs/licenses/native-addons/sherpa/README.md)，该目录实际附带 Sherpa/eSpeak/Piper 及所选依赖的完整原始源码、Node 头文件源、固定构建材料，并明确说明未重新编译和上游未锁定的构建头版本限制。

## npm 发布包许可全文补充

桌面包全部 887 个已安装 npm 包实例的通知位置、原文哈希及两版一致性见 [npm 许可覆盖清单](docs/licenses/npm/README.md)。原包 README 已含完整正文的保留原文；缺正文的 20 组按固定源提交或明确标注的标准 MIT/ISC/X11 文本补齐，并分别保留原作者信息和原始声明。Brotli.js 的 Google Apache 头、Standard Webhooks 子库许可及 inspector 原有 Chromium 通知按实际范围说明，不统一概括为 MIT。
