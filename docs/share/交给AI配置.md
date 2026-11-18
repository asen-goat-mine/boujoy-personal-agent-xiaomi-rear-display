# 给 AI 的配置执行说明

只有当接收者明确要求你按本文配置时，才执行相应操作；本文件不是分享者替接收者授予的账户、云资源或设备权限。先读取接收者当前请求与本机实际状态，完成已经授权的可逆准备，缺少真实账号/设备确认时明确交回本人，不猜测。

目标：让接收者的本版 Boujoy 在自己的 Mac 与 Android 上可验证地运行。优先完成同一局域网的主屏控制；手机聊天的异地路线另需自建加密 relay。不能继承分享者的密钥、服务器、配对记录、知识库或手机信息。

## A. 识别材料与身份

1. 确认 macOS arm64 与 Android 13+，实际机型从本人设备读取，不固定品牌、型号、序列号或 IP。非 arm64 Mac 不使用此二进制分享包。
2. 判断目录类型：有 `.app`、`构建信息.json`、`Android/`、`SHA256SUMS` 是分享包；有 `src/`、`android/`、`package.json`、`distribution.json` 是完整源码；分享包的 `配置源码/` 仅包含 relay，不能当全项目执行 `npm start`。
3. 分享包读取 `构建信息.json`，再读取 `.app/Contents/Resources/app/backend/distribution.json`。源码读取根目录 `distribution.json`。只提取 edition、productName、版本、applicationId、bundleId、端口、supportsBackground 等公开字段，不扫描个人目录找旧配置。
4. 对照同一包的 Mac、Android applicationId、版本与 SHA。两版应用可共存，不重命名应用冒充切版。不要把 Phone Use 版的 Android APK 安装为 Xiaomi 版，也不要复用另一版 DATA/Keychain。
5. 分享包在原解压目录执行 `shasum -a 256 -c SHA256SUMS`。摘要失败停止后续安装并定位损坏，不能改清单绕过。源码使用发布清单核验；缺失清单要报告“未封版”。

身份参考表：

| edition | Mac 名称 | Android applicationId | 本机端口 |
|---|---|---|---|
| phoneuse | Boujoy Phone Use | dev.boujoy.phoneuse | 18891 |
| xiaomi | Boujoy Xiaomi | dev.boujoy.xiaomi | 18892 |

完整数据/钥匙串/服务标识均读取 `distribution.json`，不要只按应用名推断；禁止将两版或个人旧版指向同一数据目录。

## B. 分享包安装与认证核验

把本版 `.app` 复制到接收者选择的应用目录。已经有同名应用时先核其版本和实际运行身份，保留可恢复的旧副本；不要覆盖未知路径或强杀进程。下面示例先由你把路径填成已经识别的本版真实路径：

```sh
boujoy_app='/Applications/替换为本版应用名.app'
boujoy_resources="$boujoy_app/Contents/Resources/app"
codesign --verify --deep --strict "$boujoy_app"
"$boujoy_resources/runtime/node" "$boujoy_resources/backend/scripts/verify-distribution.mjs" --json
```

Mac 应用已内置后端与运行依赖，不要为它另装源码环境。Gatekeeper 需要本人确认时，解释这是未公证的 ad-hoc 签名包，由本人按 macOS 的界面处理；不要全局关闭安全设置。

打开本版应用后执行：

```sh
"$boujoy_resources/runtime/node" "$boujoy_resources/backend/scripts/verify-distribution.mjs" --running --json
```

判断规则：退出 0 且 `status=running_verified` 才表示实际进程与该源码一致；退出 2 / `unsealed` 是缺少封版清单；退出 1 是失败。不要用访问首页成功、HTTP 200、文件名或 UI 版本文字代替构建身份验证。验证脚本自行建立 `/api/session`，携 Cookie 读取受保护 health；不要把完整 health、Cookie、CSRF、用户路径或日志原样贴进对话。

错版/旧 hash 不自动复用，也不杀服务。先确定占用进程属于哪个应用和启动方式，结束其任务后通过该应用或对应源码服务命令正常停止，重开目标版再验证。不要使用 `killall`、宽泛 `pkill`、清空 DATA 或删除钥匙串解决身份冲突。

## C. 完整源码路线

源码运行和构建以根 README 为准，先核版本和封版清单。经接收者授权可在其独立开发目录执行：

```sh
npm ci
npm run setup
python3 scripts/prepare-phone-use.py --include-apk
npm test
npm run check
node scripts/verify-distribution.mjs --json
```

通过后 `npm start`；在另一终端 `node scripts/verify-distribution.mjs --running --json`。若是明确的开发源码且未封版，可以继续开发，但记录未封版，不伪造发布通过。配置和运行都不得自动发现或复用分享者/接收者的旧私人 Vault、旧 harness、历史服务或密钥。

需要 Mac 开发壳或 Android APK 时才按根 README 构建。`npm run app` 是引用源码目录的开发壳，不可当分享包发给别人。Android release 保留原签名；签名不一致时不卸载、不清数据、不换一个私钥来冒充原身份。源码编辑后不能声称旧进程运行的就是新源码，必须重新构建/启动并验证。

## D. 接收者模型与局域网主屏

1. 打开“设置 → 连接 → DeepSeek”，让本人直接在应用输入自己的 Key；不要求发到聊天、不写入 shell 历史/配置文档。可核对“已配置”状态，但不读取凭证正文。
2. 让本人决定新对话云处理与记忆授权，先验证简单文本请求。不要替本人开启“自动使用 DeepSeek”或扩张记忆授权。当前语音优先调用 DeepSeek，音频/朗读文本可能外发；本机回退需另配，不把“草稿未发送”误解成音频未上云，不在未核验时宣称语音全程本地。
3. 安装固定官方 Phone Use APK，打开其界面。无障碍、通知/连接和其他系统权限由本人授权。Android 本版 Boujoy 聊天端是另一份 APK；无线输入需要时按其“无线输入”设置授权。
4. 使用实际手机显示的 HTTPS 地址在 Mac 手机设置连接。首次安全码必须本人核对两端 8 位数字；无法观察两端就等待本人确认，不自动点击确认。
5. 选择真实配对设备，保持默认 `main` / 主屏执行，亮屏解锁。先运行只读任务，再验证停止/接管。记录实际成功/失败与范围，不把连接成功当作全部手机功能通过。
6. 若另一版也连接同一手机，先暂停或结束另一版任务。没有跨发行版全局 lease，不并行控制同一手机。

不要固定 `adb -s` 的设备值。确实需要 ADB 且已获授权时先读取当前设备列表，由实际目标决定；无明确目标不向全部设备执行。安装冲突必须核签名，不能自动卸载旧应用。

## E. 可选 relay 与 Xiaomi 能力

手机 Boujoy 聊天需要接收者自己的加密 relay。没有授权服务器时先完成局域网路线，不购买主机、不部署到未知账号、不使用分享者残留地址。参考分享包 `配置源码/deploy/relay/README.md` 或完整源码 `deploy/relay/README.md`。只部署必要源码与路由哈希表，不上传个人 DATA、绑定凭据、模型 Key、TLS 私钥或知识库。公网不暴露 Mac 本机 API、Phone Use 或 ADB 端口。

部署前检查服务器现有 Compose 项目及 80/443 占用。当前脚本固定 `boujoy-relay` 项目名，两版在同机执行会更新同一组容器/配置，不因 Mac edition 自动隔离。两版独立并行的手机聊天路线使用各自服务器和路由表；已有另一版服务时保留它，不覆盖配置或混合绑定凭据。

Mac“异地连接”保存自己的 relay 地址后生成短期绑定码/文件；只交本人手机，手机端用连接码或导入文件。真实公网 TLS/证书续期、data/control 连接、任务执行、停止和移动网络重连均须验证；`healthz` 不能代替整条链路验收。排错不重复执行未确认的消息。

仅 `supportsBackground=true` 的 Xiaomi 版提供后台切换。本人启动与授权 Shizuku、开启“Boujoy 后台执行”无障碍后再检查实际 readiness；不修改能力判定来强行启用。不支持时保持主屏，后台任务不自动降级到主屏。背屏、锁屏显示和电源租约受型号/系统限制，不能说全小米或全品牌支持。

## F. 完成报告格式

只写真实结果，至少包括以下项目：

- 本版 edition、Mac/Android 版本、applicationId、sourceDigest；是否通过包摘要和运行进程一致性验证。
- 模型凭证状态（只写已配置/未配置）、云/记忆授权是否由本人完成；不要附密钥或内容。
- 实际手机连接路线、主屏只读任务/停止是否成功；后台/背屏只列确实验证的能力。
- relay 是否真实部署、公网证书/移动网络/重连哪些已测；没有做的明确未实测。
- 仍需本人处理的步骤与具体原因，保留原数据与签名冲突，不把失败写成完成。

请分别记录本版的真机重绑、首启、跨品牌和公网测试结果；单元测试只覆盖报告所列范围。配置完不要把接收者状态重新打进分享包。
