# 参与贡献

欢迎提 Issue 和 PR。这个项目目前由一个人维护，回复可能不会很快。

## 跑起来

需要 Apple 芯片的 Mac、Node.js 24 或以上。

```sh
npm ci
npm run setup      # 安装 DeepSeek Harness 到 .runtime/harness
npm start          # http://127.0.0.1:18892
```

开发时建议用单独的数据目录和端口，避免影响你日常在用的那一份：

```sh
BOUJOY_PORT=18899 \
BOUJOY_DATA=/private/tmp/boujoy-dev \
BOUJOY_MEMORY_VAULT=/private/tmp/boujoy-dev-memory npm start
```

记忆路径不存在时首次启动会自动初始化；不要预先创建空的记忆目录。已有兼容记忆库可继续使用，不兼容目录会被保留并拒绝接入。

## 测试

```sh
npm test                                   # 全部
node --test tests/live-draft.test.mjs      # 单个文件
```

依赖本机环境的测试（macOS 沙箱、Vision OCR、本地语音、Harness 运行时、Bok 记忆核心）在环境不具备时会自动跳过，并写明原因。提 PR 前请确认 `npm test` 没有失败项。

Android 聊天界面变更应覆盖刷新时的滚动位置；自动测试与真实设备操作分别记录，不把宿主测试通过写成真机验收。

## 提 PR

- 一个 PR 只做一件事，说明改了什么、为什么改、怎么验证的。
- 改了行为就补测试或更新测试。
- 涉及手机操作的改动，请写明在哪款手机、哪个 Android 版本上实测过。
- 不要提交个人数据：聊天记录、截图里的私人内容、API Key、设备序列号、本机绝对路径。
- 代码里不要为某个 App 或某个页面写死流程。原则是让模型自己判断，代码只负责清除障碍和守住安全规则。

## 设计上的几条硬规则

改动不能破坏这些：

- 同一个动作不重复执行；
- 上一步结果没确认，就不执行下一步；
- 暂停、停止、接管立即生效；
- 付款、发送这类最后一步默认留给用户确认；
- 服务只监听本机 `127.0.0.1`。
