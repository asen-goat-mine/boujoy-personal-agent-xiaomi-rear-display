# 便携 Python 中的 Tcl/Tk 及附带模块

此目录只记录随 Python 运行时实际存在的 Tcl/Tk 相关文件；没有宣称安装了完整的独立 Tcllib 发行版。版本来自运行时的 `package require -exact` / `package provide`、包索引和已安装脚本，并与官方固定版本源码归档逐字节核对。原始版权/许可按项目分别保留，不能用 CPython 自身的许可证替代。

| 组件 | 实际版本 | 许可原文 |
| --- | --- | --- |
| Tcl | 9.0.4 | [Tcl license.terms](Tcl-license.terms) |
| Tk | 9.0.4 | [Tk license.terms](Tk-license.terms)，保留 Apple 等贡献方署名 |
| [incr Tcl] / Itcl | 4.3.8 | [Itcl license.terms](Itcl-license.terms)；安装的 widget 脚本另保留 [ItclWidget 通知](ItclWidget-license.terms) |
| Thread / ttrace | 3.0.6 | [Thread license.terms](Thread-license.terms)；运行时 ttrace 源文件保留 Zoran Vasiljevic / Archiware 署名 |
| HTTP / msgcat | 2.10.2 / 1.7.1 | Tcl 9.0.4 附带模块，Tcl 许可及各脚本原始署名 |
| platform / platform::shell | 1.1.0 / 1.1.4 | Tcl 9.0.4 附带模块，Tcl 许可 |
| tcltest / opt | 2.5.11 / 0.4.10 | Tcl 9.0.4 附带模块，Tcl 许可 |
| cookiejar / tcl::idna | 0.2.0 / 1.0.1 | Tcl 许可；IDNA 另涉及下述 RFC 3492 条款 |

固定来源分别为 [Tcl core-9-0-4](https://github.com/tcltk/tcl/tree/core-9-0-4)、[Tk core-9-0-4](https://github.com/tcltk/tk/tree/core-9-0-4)、[Itcl itcl-4-3-8](https://github.com/tcltk/itcl/tree/itcl-4-3-8)、[Thread thread-3-0-6](https://github.com/tcltk/thread/tree/thread-3-0-6)。[sources.json](sources.json) 给出实际下载的归档 URL/SHA-256、原始许可所在路径和共 86 项已安装脚本/数据的逐字节匹配证据。本次没有重建这些原生库。

## Tcl 内部组件与 IDNA

Tcl 源树的 LibTomMath 许可原文见 [Tcl-libtommath-LICENSE.txt](Tcl-libtommath-LICENSE.txt)。正则表达式引擎保留 [Henry Spencer 的完整版权及许可头](Tcl-regex-Henry-Spencer.txt)，取自同一固定源码的 `generic/regcomp.c`，不改写原条款。

安装的 `idna.tcl` 明确说明其 Punycode 实现翻译自 RFC 3492 附录 C，并有实质性修改；另有 Copyright © 2014 Donal K. Fellows。原始文件头见 [IDNA-source-attribution.txt](IDNA-source-attribution.txt)。同时保留 [RFC 3492 原文](RFC-3492.txt)，其中附录 B 是作者的免责声明和授权，末尾保留 Internet Society 的完整版权说明。这里不把 Tcl 改写版误称为 RFC 原作者的未修改实现。

## Cookiejar 随附的 Public Suffix List

原始文件内明确标注 [MPL 2.0](MPL-2.0.txt)。本目录提供实际随包的 [压缩原件](public_suffix_list.dat.gz) 和 [完整解压源码/数据](public_suffix_list.dat)，保留全部原有说明、注释与条目，没有修改列表内容。

已核对运行时 `lib/tcl9.0/cookiejar0.2/public_suffix_list.dat.gz` 与 [Tcl 固定 tag 的该数据文件](https://raw.githubusercontent.com/tcltk/tcl/core-9-0-4/library/cookiejar/public_suffix_list.dat.gz) 在源码归档内完全一致：

```text
gzip SHA-256: 22b8b49a17178863832dbbb646946b38f0f879cb1cd5cb3e7490e62a055fc623
text SHA-256: 6d5a41890175e65826f2a3532369925067d840e324631eb8b8008dc5f9ffebad
```

这些是实际分发版本的数据证据；没有推测列表收集日期，也没有声称该快照与 publicsuffix.org 当前最新版相同。Tcl/Tk 通用许可不取代这份数据单独适用的 MPL 2.0。

核验日期：2026-11-15。
