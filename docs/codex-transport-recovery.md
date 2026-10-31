# Codex 传输恢复与诊断

## 范围

插件管理传输偏好、冷却和恢复时机；pi-ai 管理 socket、Responses 协议及增量上下文；DSH 管理完整模型请求重试及工具执行。本改动不修改 DSH 核心、压缩协议、持久历史、生产配置或 HTTP 实现，不代表 ECONNRESET / UND_ERR_SOCKET 的根因已解决。

## 恢复策略

- WebSocket 优先；SDK 报告该 scope 的 sticky fallback 后，后续调用明确选择 SSE。
- 冷却默认 30 秒，连续失败指数增加，带 ±20% jitter，最终硬上限 5 分钟。使用单调时钟，无后台模型探测或保活请求。
- 到期后的下一次真实请求可恢复。要求 scope 没有活跃 producer；每 scope 一个恢复尝试，同账户/endpoint/代理路由也只允许一个恢复尝试。健康 WS 不受此恢复限流影响，不能取得资格的请求立即走 SSE。
- 只在安全空闲点对非空、精确的 SDK session key 调用公开 close/reset。reset 同时清 sticky 标记和 SDK 计数，因此先累计计数差值，保留进程内总数。
- 恢复必须实际走 WS 并取得成功终态；WS 失败后 SSE 成功、取消、业务失败均不计恢复成功。取消/业务失败不增加 WS failure streak。
- 新 socket 由 SDK 发送完整有效上下文，不沿用旧 previous_response_id；后续前缀匹配时再使用 SDK 增量机制。
- SDK 正常 5 分钟空闲回收和 55 分钟连接年龄轮换不算传输故障，不触发冷却。
- 明确 SSE、cloud compaction 强制 SSE、Auto review、无稳定 session 或 cacheRetention:none 不参与恢复探测。保留已有 Auto review 缓冲重试，不新增模型/HTTP重试层。

## 生命周期与隔离

scope 基于插件 namespace、DSH session、稳定账户、endpoint 和代理进行哈希。同账户刷新 token 保持 scope；账户或路由改变会隔离连接。最多保存 256 个 scope，惰性清理空闲超过 30 分钟的状态及非活跃 LRU；容量耗尽时使用 SSE，绝不为腾空间关闭活跃流。

consumer.return 会取消本次 SDK producer，但不立即宣布连接可安全重置。租约在 SDK result 完成、socket 已释放后结束。账户清理关闭旧连接、轮换 namespace，阻止尚在等待代理解析的旧 prepare 再次出站；活跃旧 scope 的计数清理延后到 producer 结束。

首个响应事件（包括 response.created）之后断开，不由插件切到 SSE 重放。失败仍交给 DSH；不重新执行已经完成的工具，也不承诺远端 exactly-once。

## 诊断

- model 的状态以整个 SDK attempt 终态记录一次，而不是 HTTP 头或某次 iterator.next 返回成功。
- requestHistory / requests.model 增加 attemptId、最终 requestedTransport、实际 transports、选择原因、匿名 scope、阶段、路由、耗时桶和 allowlist 网络错误码。streamFailure.attemptId 可直接关联，不靠时间戳推断并发请求。
- 终态区分 ok / failed / cancelled / abandoned；后续迭代完成不能覆盖失败。采集 pass 仍只代表诊断成功采集。
- streamFailure.request.options 现在保存插件改写后的选项，但实际路径仍以 transports 为准。
- transportRecovery 提供 bounded preferred / cooldown / probing 状态、活跃数和冷却剩余。它是诊断报告字段，本次没有新增设置页实时状态徽标。
- websocket 原有计数仍为 SDK 语义。显式冷却 SSE 另外计入 cooldownRequests；recoveryAttempts / recoverySuccesses / recoveryDeferrals 描述插件恢复行为，不能把 sseFallbacks 当断线次数。
- 历史保留 32 条并报告 dropped；scope 不含原始 session、账户、token 或代理地址。实际传输观察复用既有 AsyncLocalStorage fetch/WS seam，不替换协议。

## 验证与限制

离线 fixture 使用真实 SDK + 模拟 WebSocket/fetch，仅合成消息和假令牌，无外网模型调用。工作区 pi-ai 0.85.1 与安装版 1.1.0 均通过：正常 WS、握手失败、SSE 冷却、同会话恢复全量、后续增量、真实 SDK 空闲 timer 回调、55 分钟年龄轮换、首事件后断开无 SSE 重放、取消释放租约。安装版通过 DSH 独立 run_code/Electron 进程加载 ASAR 中 provider 与 API，并一起注入同一 fixture；不能将工作区测试冒充安装版测试。

纯策略测试另覆盖并发 single-flight、跨会话恢复限流、账户/endpoint隔离、退避、容量/LRU、账户清理竞态、计数不下降。诊断测试覆盖真实 SDK fetch cause、HTTP 200 后 error 事件、并发独立终态及取消。

仅以上两个 SDK 版本在本轮执行了新契约；未声称所有 peer 白名单版本均已重测。其他版本升级应先执行同一 fixture。冷却参数仍需后续授权实网数据调优；没有部署或真实网络可靠性结论。

关键实现：[connection](<../src/subscription-connection.js>)、[runtime](<../src/pi-ai-runtime.js>)、[attempt evidence](<../src/model-attempt.js>)、[network seam](<../src/oauth-network.js>)。

关键测试：[policy](<../tests/subscription-recovery.test.mjs>)、[SDK contract](<../tests/helpers/recovery-sdk-contract.mjs>)、[attempt diagnostics](<../tests/network-failure-diagnostics.test.mjs>)。

2026-10-30 验证结果：构建通过，git diff --check 通过；构建后相关测试 62/62 通过。完整回归 1379 项：1372 通过、6 跳过、1 失败。唯一失败仍为先前已存在的 [Unicode 路径卸载测试](<../tests/powershell-manager.test.mjs#L376-L396>)，错误是保存的安装目标不可读；本次未修改该安装器或其测试，不将此项当作通过。安装版 pi-ai 1.1.0 的最终独立 fixture 通过了恢复、增量、空闲/年龄轮换和取消合同。
