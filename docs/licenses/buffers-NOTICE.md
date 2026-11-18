# buffers 0.1.1：许可来源

作者：James Halliday。原 npm 包的 `repository` 指向 `https://github.com/substack/node-buffers`；该地址在本次核验时返回 404。npm 0.1.1 包没有独立 LICENSE，也没有 `license` 字段，不能把包中未提供的文本称为上游原始许可证。

原作者的 Git 提交 `1b745ee35d33eb166e15ef1866073a07c6d7de87` 保留在 bitpay fork 中；提交作者为 James Halliday，提交标题为 `license`。该提交向 README 和 package.json 加入了 MIT/X11 声明：

- [原作者许可提交](https://github.com/bitpay/node-buffers/commit/1b745ee35d33eb166e15ef1866073a07c6d7de87)
- [固定提交的 package.json](https://raw.githubusercontent.com/bitpay/node-buffers/1b745ee35d33eb166e15ef1866073a07c6d7de87/package.json)
- [固定提交的运行源码 index.js](https://raw.githubusercontent.com/bitpay/node-buffers/1b745ee35d33eb166e15ef1866073a07c6d7de87/index.js)

本项目锁定版本中实际安装的 `buffers/index.js` 与上述固定提交的文件逐字节一致。二者 SHA-256 均为：

```text
97801e296ba5f3c32242f647e1daac5917e300367fed7935ab1e62f40adb1b8a
```

本目录附上 [标准 MIT 许可文本](buffers-MIT.txt)，署名沿用原包作者 James Halliday，不补造版权年份。此文本是为随软件提供完整条款而补附的标准文本，并非声称原 npm 包或上述提交曾包含独立 LICENSE 文件。[MIT 标准文本参考](https://opensource.org/license/mit)。

核验日期：2026-11-15。
