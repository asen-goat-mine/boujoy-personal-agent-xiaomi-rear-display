# 便携 Python 运行时：来源和第三方许可

本包包含 CPython 3.12.14 的标准库及其已编译依赖，来自 python-build-standalone 的 macOS ARM64 构建；不附带 Python site-packages、pip 或 ensurepip。开发和可选语音环境使用接收者自行准备的 Python/pip。

## 确切发行来源

本次依据 [官方 20260825 发布](https://github.com/astral-sh/python-build-standalone/releases/tag/20260825)和固定构建仓库提交 [c0aa3bbdc2fff56a77ad1ecec68b1e47794d8779](https://github.com/astral-sh/python-build-standalone/tree/c0aa3bbdc2fff56a77ad1ecec68b1e47794d8779)核对。install_only 与 pgo+lto-full 两个官方构件均实际下载并与官方发布元数据 SHA-256 一致，URL/哈希保存在 [sources.json](sources.json)。

运行时输入和官方 install_only 中的解释器、libpython、Tcl、Tk 四个 Mach-O 文件的全部有内容区段，名称、数量和区段 SHA-256 均一致。整个文件哈希并不相同，因此这里不声称它们逐字节等同；本地应用分发会涉及 Mach-O 签名等区段外封装。此项核对用于确认编译内容来源，完整区段证据保存在 sources.json。

从官方 full 构件原样提取了 [PYTHON.json](upstream-PYTHON.json) 和整个 [licenses 目录](standalone-originals/)，每份通知的归档条目和 SHA-256 均在 sources.json。该目录保留上游完整通用许可集合，包含其他平台/变体的通知；保留通知不表示每个列名组件都被本包使用。

## 本次实际运行组件

- **CPython 3.12.14**：Python/CNRI 许可，见 `standalone-originals/LICENSE.cpython.txt`；解释器自己的 `lib/python3.12/LICENSE.txt` 也保留。
- **OpenSSL 3.5.8、SQLite 3.53.1、Expat 2.8.3、bzip2 1.0.8、liblzma 5.4.3**：版本通过隔离且禁止字节码写入的解释器只读查询取得。原版通知分别见 `LICENSE.openssl-3.txt`、`LICENSE.sqlite.txt`、`LICENSE.expat.txt`、`LICENSE.bzip2.txt`、`LICENSE.liblzma.txt`。
- **libffi、mpdecimal、libuuid**：官方 PYTHON.json 明确列为 ctypes、decimal、uuid 模块的静态链接依赖；保留其原始 MIT/BSD 等通知，不从机器上的无关安装版本推测版本号。
- **Tcl 9.0.4、Tk 9.0.4、Itcl 4.3.8、Thread 3.0.6 及其附带脚本**：另见 [Tcl 组说明](tcl/README.md)，包括实际 Public Suffix 数据、MPL 2.0 与 IDNA/RFC 3492 来源通知。

Mach-O 装载命令显示 zlib、libedit、ncurses、panel 从 macOS `/usr/lib/` 加载；本包没有复制这些系统动态库。上游 full 构件的通用许可证仍予以保留，但不把系统库运行时版本冒称为本包分发的库版本。

各模块的准确链接类型、上游声明的许可路径及分发条件以原始 PYTHON.json/通知为准；CPython 的许可不替代它编入的第三方库许可。本次只补齐公开通知和来源材料，没有改动解释器机器码或运行源码。

核验日期：2026-11-15。
