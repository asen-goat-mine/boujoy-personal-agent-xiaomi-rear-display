# Android 运行依赖许可

此目录覆盖应用 release 依赖；JUnit、Robolectric、MockWebServer、okhttp-tls 等测试工具不作为应用运行依赖列入。精确 Maven 坐标、实际构建缓存中 AAR/JAR 的 SHA-256、固定版本 POM/下载链接及许可文本哈希见 [sources.json](sources.json)。这些通知也逐字节复制到 APK 的 `assets/third-party-licenses/`。

| 组件 | 本次版本 | 许可与通知 |
| --- | --- | --- |
| Shizuku API / Provider / AIDL / Shared | 13.1.5 | [MIT](Shizuku-MIT.txt)，Copyright (c) 2021 RikkaW；四个固定版本 POM 都指向 Shizuku-API 的 MIT 许可 |
| AndroidX Annotation | 1.3.0 | [Apache 2.0](Apache-2.0.txt)，Android Open Source Project |
| OkHttp | 4.12.0 | [Apache 2.0](Apache-2.0.txt)，Square；内含 Public Suffix 数据另适用下述 MPL 2.0 |
| Okio JVM | 3.6.0 | [Apache 2.0](Apache-2.0.txt)，Square |
| Kotlin stdlib、stdlib-common、stdlib-jdk7、stdlib-jdk8 | 1.9.10 | [Apache 2.0](Apache-2.0.txt)，JetBrains 及贡献者；保留 [上游 NOTICE](Kotlin-upstream-NOTICE.txt) |
| JetBrains annotations | 13.0 | [Apache 2.0](Apache-2.0.txt)，JetBrains |

Shizuku 的许可原文取自 [固定许可提交 ffb074f10cf615ca96f2153b1aee604a50503be0](https://github.com/RikkaApps/Shizuku-API/blob/ffb074f10cf615ca96f2153b1aee604a50503be0/LICENSE)。该路径是许可文件的提交记录，不将其误称为 13.1.5 发布 tag。版本对应关系来自 Maven 的 13.1.5 POM。

OkHttp、Okio、Kotlin 各自固定版本仓库中的 LICENSE 与本目录 Apache-2.0.txt 字节一致。Kotlin 上游 NOTICE 标题写作 Compiler distribution，此处原样保留署名；本应用只包含上表标准库，不包含 Kotlin 编译器。已用 APK 内全部 7 个 `.kotlin_builtins` 资源与 stdlib 1.9.10 JAR 逐字节核对，以区别测试工具带来的其他 Kotlin 版本。

## OkHttp 内含 Public Suffix 数据

原 [NOTICE](okhttp-publicsuffix-NOTICE.txt) 指明该数据受 [Mozilla Public License 2.0](MPL-2.0.txt) 约束。随包附上实际数据原件 [okhttp-publicsuffixes.gz](okhttp-publicsuffixes.gz)，以及只解压并拆出两段 UTF-8 字段的 [规则列表](okhttp-publicsuffix-rules.txt) 和 [例外列表](okhttp-publicsuffix-exceptions.txt)，没有改动规则。

可以直接定位本次数据的固定版本来源：

- [OkHttp parent-4.12.0 的原始 publicsuffixes.gz](https://raw.githubusercontent.com/square/okhttp/parent-4.12.0/okhttp/src/main/resources/okhttp3/internal/publicsuffix/publicsuffixes.gz)
- [同一 tag 的原始 NOTICE](https://raw.githubusercontent.com/square/okhttp/parent-4.12.0/okhttp/src/main/resources/okhttp3/internal/publicsuffix/NOTICE)
- [固定版本 Maven JAR](https://repo.maven.apache.org/maven2/com/squareup/okhttp3/okhttp/4.12.0/okhttp-4.12.0.jar)，内部条目 `okhttp3/internal/publicsuffix/publicsuffixes.gz`

固定 tag 文件、实际 JAR 条目和本次构建 APK 条目的字节完全一致。原始 gzip 的 SHA-256：

```text
9af43e9995ec749e7a30eec4e5a87770d7e2027847084a07cca82060eff0c791
```

这些链接定位实际随包数据；本说明不推测其上游列表采集日期，也不声称它与 publicsuffix.org 当前最新版相同。完整来源与提取文件的哈希见 sources.json。

核验日期：2026-11-15。
