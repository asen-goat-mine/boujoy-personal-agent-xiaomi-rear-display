# Boujoy 分享包

先阅读 `构建信息.json` 确认本包是 **Phone Use** 还是 **Xiaomi**；同一 edition 的 Mac 应用和 Android APK 必须配套。当前文件是接收者入口，具体版本以构建信息为准。

1. [SETUP.md：安装与首次配置](SETUP.md) — Apple silicon Mac、Android 13+、本人模型凭证、局域网主屏配对。
2. [AI-SETUP.md：交给 AI 执行配置](AI-SETUP.md) — 先核身份和摘要，再操作；不代替用户授权设备权限。
3. [版本与验证.md](版本与验证.md) — 离线封版与实际运行进程校验，区分已验证和未实测。
4. [TROUBLESHOOTING.md：排错](TROUBLESHOOTING.md) — 服务错版、Android 签名冲突、手机权限、异地连接。

包内 `.app` 已带运行依赖；`Android/` 是手机组件；`配置源码/` 只用于部署自己的加密 relay，**不是完整的 Mac/Android 开源源码**。完整源码另以独立归档提供。`LICENSE`、`THIRD_PARTY_NOTICES.md`、`Licenses/` 与 `docs/licenses/` 保留软件许可。

不部署服务器也可以先从 Mac 在同一局域网操作已配对的手机主屏。从手机 Boujoy 聊天联系 Mac 需要自己的加密 relay。Xiaomi 后台与背屏需实际能力、Shizuku 和用户授权，不能推断所有小米机型均支持。

两版可以并存且数据独立；同一手机一次只让一版执行，切换前暂停或结束另一版任务。新公开包名的真机重绑和公网部署若没有测试记录，均视为未实测。不要把模型密钥、绑定文件或个人数据发给分享者。
