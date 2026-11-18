# 本机 UI 审查服务

启动：`node tests/helpers/ui-audit-server.mjs --port 18795`。若端口占用，自动选择空闲 loopback 端口并打印实际 URL。只绑定 `127.0.0.1`；Ctrl+C 退出。状态、消息、上传附件和日志全部只在内存，退出即丢弃。

服务直接读取本项目真实 `web/` 文件，**不修改或注入前端脚本**，不导入服务器/Engine/模型/手机模块，不读生产运行目录、钥匙串或知识库，不发外部请求。真实页面审查必须通过浏览器 UI；本 helper 不使用浏览器工具、Playwright 或 DOM 注入。静态页面具有仅本源 CSP，外部示例链接不是审查服务请求。

## 入口

- 默认 `http://127.0.0.1:18795/`：总助理；通过**设置 → 对话记录**进入全部合成历史。
- `/#role/audit-empty`：没有任务的助理，显示真实欢迎空态；也可用设置中的“新对话”。
- `/#role/audit-other`：另一位助理，测试发送期间切换与草稿保留。
- `GET /__audit/manifest`：当前配置、全部 fixture IDs、任务状态及计数。
- `GET /__audit/logs`：所有模拟 API 请求，`messageRequests` 是发送HTTP次数，`acceptedMessages` 是唯一接受的请求数，`duplicateRequests` 是幂等重试数。日志不记录消息正文、附件字节或密钥值。

历史任务包括 `audit-long-markdown`、`audit-running`、`audit-failed`、`audit-stopped`、`audit-payment`、`audit-unknown`、`audit-needs-input`、`audit-attachments`、`audit-consent`、`audit-approval`、`audit-setup`、`audit-paused`、`audit-empty-session`；`audit-archived` 在“已归档”页。付款任务同时具有 `checkout`、`handoff`、报价和明确的合成说明。长答复含表格、链接、长URL、长代码、不可信HTML文字和多段列表。

## 服务端控制

仅通过本机 HTTP 改 fixture，不修改浏览器内部状态。控制请求：

```sh
curl -fsS http://127.0.0.1:18795/__audit/control \
  -H 'Content-Type: application/json' \
  -H 'X-UI-Audit-Control: local-fixture' \
  --data '{"action":"next-send","ackDelayMs":6000,"replyDelayMs":1500}'
```

然后在真实 UI 发送消息，在6秒回执到达前切到另一位助理并输入新草稿；检查晚到回执不夺取当前会话，日志中没有多次接受。`next-send` 只影响下一次新请求；`configure` 设置后续默认行为。

| 控制 body | 行为 |
| --- | --- |
| `{"action":"next-send","failBeforeCommit":true}` | 下一次发送返回503，不创建任务，检查草稿恢复 |
| `{"action":"next-send","dropReceipt":true}` | 提交后断开HTTP回执；同请求ID重试只返回原任务 |
| `{"action":"configure","autoReply":false}` | 新任务一直保持处理中，方便截图；人工停止仍生效 |
| `{"action":"task","id":"audit-running","progress":"第二段合成进展"}` | 添加进展并通过SSE触发真实前端刷新 |
| `{"action":"task","id":"audit-running","status":"completed","result":"合成任务处理完成"}` | 切到终态并展示结果 |
| `{"action":"offline","durationMs":10000}` | 断开SSE并使普通API返回503；10秒后恢复，不重发任何消息 |
| `{"action":"online"}` | 提前恢复 |
| `{"action":"clear-logs"}` | 清HTTP日志，不删除幂等账本或任务 |
| `{"action":"reset"}` | 重建全部合成任务并清账；不要在发送等待中使用 |

默认消息900ms后生成合成回复。预置运行中任务保持运行，直到手动控制或前端停止；避免截图时自动消失。附件下载返回真实内存TXT/CSV字节；用户通过UI上传的测试附件也只存本fixture内存。语音/配对/真实密钥保存等执行接口明确不实现，绝不转发生产。

HTTP契约自测：`node --test tests/helpers/ui-audit-server.test.mjs`。这些测试不代表浏览器布局、视觉或实际业务验收。
