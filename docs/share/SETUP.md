# 首次配置：分享包

本说明适用于 Apple silicon / arm64 Mac 与 Android 13+ 手机。版本、发行版、Android applicationId 以包内 `构建信息.json` 和应用内 `backend/distribution.json` 为准；Phone Use 与 Xiaomi 的包不要交叉安装或改名混用。源码用户先按源码根 README 安装依赖，再使用相同界面步骤。

## 1. 核验并打开 Mac 应用

1. 完整解压分享包。打开终端进入解压目录，执行 `shasum -a 256 -c SHA256SUMS`。失败先重新获取可信包，不修改清单来消除失败。
2. 将其中的 `Boujoy Phone Use.app` 或 `Boujoy Xiaomi.app` 复制到自己的“应用程序”目录。两版可同时保留，数据独立。不要把 app 的内部 backend 单独搬走。
3. 在本机核验应用签名与封版源码。下面变量需要填入你实际复制的本版应用路径：

   ```sh
   boujoy_app='/Applications/替换为本版应用名.app'
   codesign --verify --deep --strict "$boujoy_app"
   boujoy_resources="$boujoy_app/Contents/Resources/app"
   "$boujoy_resources/runtime/node" "$boujoy_resources/backend/scripts/verify-distribution.mjs"
   ```

4. 打开应用。此包使用本地 ad-hoc 签名，未声称已获 Apple Developer ID 公证；若 macOS 拦截，先核实来源与摘要，再通过系统提供的“打开”/“隐私与安全性”流程处理。不要全局关闭 Gatekeeper 或让 AI 批量清除隔离属性。
5. 应用运行后，用同一命令加 `--running`：

   ```sh
   "$boujoy_resources/runtime/node" "$boujoy_resources/backend/scripts/verify-distribution.mjs" --running
   ```

   必须显示实际进程与封版身份一致。若错版或源码不同，按 [排错](TROUBLESHOOTING.md) 正常停止你确认过的旧服务；检查器不会替你杀进程。

## 2. 配置自己的模型

在 Mac 打开“设置 → 连接 → DeepSeek → 连接”，亲手填写自己的 API Key。密钥进入本发行版的 macOS 钥匙串，不应交给聊天、写进 README、放进命令行或发给分享者。

在新对话中，按界面提示选择是否“使用 DeepSeek 处理”。对话/执行结果可能发送给供应商；记忆使用是单独设置。先发一个简单文本任务验证模型连接，再添加手机。录音/朗读在用户主动发起时使用。当前语音实现优先调用 DeepSeek，录音或朗读文本可能发送到供应商；本机语音回退另需准备依赖，不能承诺全程本地。模型费用由自己的账户承担，界面的请求数上限不是金额上限。

## 3. 先连同一局域网的 Android 主屏

此步骤可先完成，不要求云服务器，也不要求先绑定 Boujoy Android 聊天端。

1. 在自己的 Android 13+ 手机上安装分享包 `Android/PhoneUse-1.3.0.apk`。官方 Phone Use 是手机操作组件，和 `Boujoy-<edition>-Android-<version>.apk` 聊天端用途不同。已有同包名应用若签名不匹配，停止安装并核对来源，**不要自动卸载或清数据**。
2. 打开 Phone Use，按它的界面亲手启用必要的无障碍服务及连接权限。保持手机和 Mac 在可相互访问的网络，主屏亮着并解锁。
3. 从手机执行端读取它实际显示的 HTTPS 地址。在 Mac“设置 → 连接 → 手机 → 查看”中填写“手机 HTTPS 地址”，点击“连接手机”。地址由当前手机提供，不预填作者设备、IP、品牌或序列号。
4. 首次配对需要核对安全码。本人在两端确认显示的 8 位安全码一致后才确认；AI 不替用户猜测或自动接受安全码。
5. 在 Mac 选择已配对的真实设备，保持“主屏执行”。先做只读的小任务，例如查看当前页面，再做本人明确授权的轻量操作并验证停止按钮。

如果需要通过 Boujoy 的无线输入补充文字输入，再安装本版 Boujoy Android，按其“设置 → 无线输入”进入系统设置，由本人授权。不要为了局域网控制开放 ADB 或把 8443 映射到公网。

通用 Phone Use 版不提供 Xiaomi 后台/背屏切换。不同 Android 厂商的电池、无障碍和网络限制不同；支持 Android 13+ 不等于所有型号都做过真机测试。手机 IP 变化后更新实际地址，不沿用旧地址硬连。

## 4. 可选：从手机聊天联系 Mac

**Boujoy Android 聊天端需要自建加密 relay**；只安装 APK 不会自动获得作者的服务器。Mac 必须在线并联网。主屏任务仍要求手机解锁；合盖、手动休眠、断电或关机会使 Mac 离线。

1. 按 包内 relay 部署说明 `配置源码/deploy/relay/README.md` 在本人授权的 Linux 服务器准备 Docker/Compose 与可信公网 TLS。分享包仅提供 `配置源码`；源码归档使用根目录 `deploy/relay/README.md`。没有服务器时可以继续使用上一节的局域网 Mac 控制路线。
2. Mac 打开“设置 → 异地连接 → 管理 → 连接设置”，输入自己已部署的 `wss://实际域名或公网IPv4/v1/tunnel`，保存连接。按部署文档把本版 DATA 下的 `remote/relay-routes.json` 哈希路由表配置到服务器；不要复制模型密钥、state.json、网关私钥、Phone Use 配对目录或知识库。
3. 在手机安装与本 Mac edition 匹配的 `Android/Boujoy-<edition>-Android-<version>.apk`。核对签名，不用自动卸载解决冲突。
4. 在 Mac“异地连接”点击“绑定手机”，生成短时有效连接码/二维码或“保存绑定文件”。在手机 Boujoy 的设置使用“连接码”或“导入连接文件”，也可用系统扫码后打开本版绑定链接。绑定码与文件只给自己的设备，过期重新生成，使用后删除临时副本。
5. 先用 Wi-Fi 验证文本对话、任务停止和接管，再切移动网络检查重连；任务未确认时查询原消息状态，不重复发送同一操作。撤销旧手机在 Mac“异地连接 → 撤销手机绑定”完成。

relay 转发加密字节；公网 TLS、路由授权、两条连接和端到端执行均需独立核验，`/healthz` 成功不等于手机任务可执行。没有真实部署记录时不能声称公网异地已验收。

两版在 Mac 上的应用和数据可并存；当前 relay 部署脚本仍使用同一个 `boujoy-relay` Compose 项目名和 80/443 端口。要同时保留两版独立的手机聊天连接，请分别使用不同服务器及各自路由表；本说明不提供同机双 relay 部署。服务器已有另一版 relay 时，不直接重复运行部署脚本覆盖它。

## 5. 仅 Xiaomi 版：后台与背屏

默认仍是“主屏执行”。希望尝试后台显示时，先在手机启动 Shizuku，亲手授予 Boujoy 权限，再在无障碍设置开启“Boujoy 后台执行”。手机 Boujoy 设置会显示“授权 Shizuku”“Boujoy 后台执行”“背屏进度”等状态；“锁屏显示权限”仅在对应设备能力判定支持时显示。

Mac 手机设置切换“后台显示执行”后，必须等权限、服务、显示能力都就绪。**后台不可用会暂停，不会偷偷改到主屏执行。** 背屏进度依赖实际副屏；锁屏显示与背屏电源租约另有系统限制，后者当前包含严格的特定型号/系统构建白名单。不是所有小米机型都能用，不能把 Android 主屏支持等同背屏支持。系统升级后重新核验，不用修改白名单强行绕过。

## 两版并存、升级与隐私

- 两版 Mac、Android 有独立应用身份，默认 DATA、记忆和钥匙串不覆盖；不会继承个人旧包账号。也不要手动让两版指向同一数据目录。
- 同一手机一次只用一个发行版执行任务。切换前暂停或结束另一版任务；没有跨版全局执行租约。
- 主屏或后台权限由本人在设备上完成。API Key、一次性绑定码、路由凭据、签名私钥、个人聊天、截图与设备配对文件都不放进分享包或排错记录。
- 更新前保留自己的数据备份和原签名。遇到签名不匹配停下核对；不要卸载旧应用来“修复”。
- 本次公开版使用新 applicationId。接收者需要验证本版的真机安装与重绑；实际结果见本包测试记录，没有记录的事项按“未实测”处理。

需要 AI 协助时交给它 [AI-SETUP.md](AI-SETUP.md)。常见问题见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)，验证范围见 [版本与验证](版本与验证.md)。
