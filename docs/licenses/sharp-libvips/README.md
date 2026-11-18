# sharp / libvips：运行依赖许可与对应来源

桌面包的 DeepSeek Harness 带有 `@img/sharp-libvips-darwin-arm64` **1.3.4**，其中 `lib/libvips-cpp.8.18.7.dylib` 包含 libvips 8.18.7 及多项图像、字体与排版库。该包自身声明 `LGPL-3.0-or-later`。各组成库按上游 [第三方通知](upstream-THIRD-PARTY-NOTICES.md) 分别适用 LGPLv3、MPL 1.1、MIT、BSD、字体许可、专利许可等条款；不能将整个原生库概括为 MIT 或 Apache 2.0。

## 随包保留的许可与署名

- [LGPL 3.0 全文](LGPL-3.0.txt) 及其引用的 [GPL 3.0 全文](GPL-3.0.txt)。上游以 LGPL 2 / 2.1 的“或后续版本”选项使用 LGPLv3。
- Cairo 对应的 [MPL 1.1 全文](MPL-1.1.txt)。
- [各组成库的原始通知](components/)：从实际固定版本的官方源码归档提取，保留原始版权、许可及适用的专利声明；包含 libvips 内嵌的 libnsgif、AOM 及所附第三方通知、FreeType FTL、IJG 声明和 GLib 的 SPDX 许可集合。源归档内另有测试工具或可选插件许可，它们不自动成为本应用运行库的许可。
- 本包文档保留 FreeType 要求的署名：**Portions of this software are copyright © 2026 The FreeType Project (https://freetype.org). All rights reserved.** 年份对应 [FreeType 2.14.3 源文件的版权声明](https://raw.githubusercontent.com/freetype/freetype/VER-2-14-3/include/freetype/freetype.h)。原文及作者见 [FTL](components/freetype/docs/FTL.TXT)。
- **This software is based in part on the work of the Independent JPEG Group.** 详见 [原始 README.ijg](components/mozjpeg/README.ijg) 和 [mozjpeg 许可说明](components/mozjpeg/LICENSE.md)。

Boujoy 自有代码的许可见项目根目录 LICENSE。这里的第三方条款独立适用。

## 固定版本源码与重建材料

本次逐项核对了实包 [versions.json](versions.json) 的 28 个版本；它们与 sharp-libvips `v1.3.4` 的 [versions.properties](upstream-build/versions.properties) 完全一致。该 tag 指向提交 [`ebb95f8add54eee8bed840e3fb587e4cbec857d7`](https://github.com/lovell/sharp-libvips/tree/ebb95f8add54eee8bed840e3fb587e4cbec857d7)。

1. 完整固定提交构建源归档已放在 `source-archives/sharp-libvips-build-source.tar.gz`；其原始来源是 [固定提交的构建源码](https://github.com/lovell/sharp-libvips/archive/ebb95f8add54eee8bed840e3fb587e4cbec857d7.tar.gz)。本目录同时保留相关原始 [build.sh](upstream-build/build.sh)、[macOS/POSIX 构建脚本](upstream-build/build/posix.sh)、ARM64 平台参数与 [5 个补丁快照](upstream-build/patches/)。这些脚本包含上游自己的源代码变更，不能只下载未打补丁的 libvips 主库来代表组合库。
2. [sources.json](sources.json) 列出所有 28 项官方源码归档的固定版本下载地址、实际下载的 SHA-256，以及原始许可文件在归档内的位置和哈希。全部 28 个完整原始源归档现已实际随包附在 `source-archives/`，并逐字节校验先前取得的 SHA-256；另附完整 sharp-libvips 构建仓库。逐项本地路径、大小和哈希见 [included-source-archives.json](included-source-archives.json)，每项明确标记 `included source archive`。接收者不必另向发行者请求或依赖上游链接持续可用才能取得这些源文件。librsvg 的 Rust 依赖补充材料见 `rust-dependencies/`。
3. 使用上游 macOS 环境要求及 `build.sh darwin-arm64v8` 入口重建。上游脚本还会下载工具链/构建工具；查看脚本后在自己的构建环境运行。本次分发审计未重编译这些库，也未声称不同工具链可以生成逐字节相同的二进制。以本目录保存的补丁快照与哈希核对远端补丁，尤其 PR 地址本身可能变化。

上述链接记录固定的上游来源；对应组件源归档与现有构建脚本/补丁已经实际附带。继续转交此包时，应把这些源归档、构建材料和许可一起保留。本次补充的是可离线取得的对应源码，不是已经安装好的离线编译工具链。

## 修改、动态替换与重新签名

允许为修改这些 LGPL 库并调试修改而进行所需的逆向工程。接收者可以重建 ABI 兼容的库并替换本地副本；不需要 Boujoy 的秘密密钥或厂商签名。

已只读核对 `sharp-darwin-arm64-0.35.5.node` 的 Mach-O 加载命令：它动态加载 `@rpath/libvips-cpp.8.18.7.dylib`，RPATH 包含相邻 `sharp-libvips-darwin-arm64/lib`。独立 dylib 在两版 App 中的位置为：

```text
<App>.app/Contents/Resources/app/harness/node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.7.dylib
```

先退出自己准备修改的 App，并复制整个 App 留作原件。把自己重建的 ARM64、同 ABI dylib 放入上述副本的位置；若改变库名或依赖布局，需要相应更新本地加载配置。修改后 macOS 签名和随包 SHA256 清单将不再匹配原件，可以对自己的副本进行本地 ad-hoc 重新签名，例如：

```bash
app="/path/to/Your Copy.app"
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"
```

这些命令是供接收者修改副本时使用的说明，本次审计未执行库替换或运行修改后的应用。自己的签名不代表原发行者签名或公证；测试修改后的功能与依赖兼容性由修改者完成。

核验日期：2026-11-15。
