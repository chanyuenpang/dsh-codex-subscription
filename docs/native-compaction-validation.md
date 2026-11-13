# 原生压缩纯插件路线：验证记录

日期：2026-10-29。状态：**验证切片，不是已经启用的功能，也不是重连修复验收。**

## 已验证的边界

- 保留完整 DSH 有效历史；检查点只是可丢弃的出站缓存。账号、模型、session、前缀、instructions/tools、有效期、摘要替换等不匹配时拒绝复用，不删除原始历史。
- [请求与收集器](<../src/native-compaction-protocol.js>)使用普通 Responses 请求末尾的 compaction_trigger，不是 inline context_management 或旧 /responses/compact。完整成功终态之前不返回检查点；取消和失败不可复活。
- [真实字节观察链](<../src/native-compaction-request.js>)覆盖 SDK、SSE 捕获及结果边界。LF/CRLF、拆包 UTF-8、EOF、解析错误、断流、取消均有合成网络测试。正常终态是边界，不声称检查终态之后的所有网络字节。
- [缓存](<../src/native-compaction-state.js>)保留原有 user/system/developer 消息及其图片，并保存加密项；闭合工具调用/结果被检查点吸收，新增工具对原样保留。prompt_cache_key 是进程/连接属性，不作为历史语义变化。
- [WebSocket 验证](<../scripts/experiments/native-compaction-socket.mjs>)在开发 SDK 0.85.1 和实际安装 SDK 1.1.0 上均通过：同一模拟 socket 发送三次；压缩改变前缀后改发完整输入，随后恢复 previous_response_id 增量，不调用 HTTP。
- [宿主验证](<../scripts/experiments/native-compaction-host.mjs>)直接加载安装中的 DSH rc.3 类，在独立 Context 和假依赖上通过十项检查。小子类可跳过 Codex 自动 pressure/overflow 路径、让其他 provider/禁用状态回到 basic、保留手动入口、拒绝第二个同名服务。未启动 DSH 应用、未写真实 session 或配置。

## 尚未通过／明确不承诺

- [真实模型探针](<../scripts/experiments/native-compaction-live.mjs>)仅使用合成文本、既有 Codex 登录，不刷新凭据、不执行模型工具。一次 native 请求已产生合成检查点文件；**新进程续接尚未成功验收**。不能将 GUI 子进程的 exit 0 等同于三个阶段通过；脚本现要求独立恢复回执。
- 首次恢复时暴露了连接 prompt_cache_key 与历史绑定混在一起的问题，已有修正及单测；尚未做修正后的 live 复测。用户提供持续重试截图后停止了额外模型测试。
- [路由候选](<../src/native-compaction-routing.js>)需要通过启动配置替换原 basic，而不是同时加载两套服务。当前未安装、未挂入生产入口。pre-step 读取上一轮已提交路由，模型切换首步有一拍差异。
- 手动入口只验证了空合成 surface 的维护路径与继承，未验收一次完整持久化手动摘要事务。
- 原生自动阈值、连续多次压缩、无效压缩熔断、Auto review/预测等旁路、插件独立计量 UI 尚未接入。此切片拒绝 compaction-on-compaction，不假装能无限续接。
- 本地收集器目前只接受单独 compaction 输出，比上游更严格；上游只要求恰好一个 compaction，可能忽略其它输出项。本地保留全部用户/开发者/系统消息，没有复制上游的保留消息截断预算。不能宣称完整复刻原生运行时。
- 不承诺节省计费 tokens、提高质量、扩大模型窗口或消除重连。

协议依据：[固定版本请求构造](<https://raw.githubusercontent.com/openai/codex/rust-v0.145.0/codex-rs/core/src/compact_remote_v2_attempt.rs>)；[输出收集与历史重建](<https://raw.githubusercontent.com/openai/codex/rust-v0.145.0/codex-rs/core/src/compact_remote_v2.rs>)（完整源中的 collect_compaction_output 385–443、build_v2_compacted_history 445 起）。网页工具截断部分后来通过只读公开源码请求补齐。

## 当前会话重试：单独的诊断结论

用户截图显示不同轮次出现 1/10、约半秒后重试和 fetch failed。这不是原生压缩已经启用，也不能证明同一请求重试十次。保存的配置为 dsh 压缩与 websocket；这是配置证据，不是对每一次请求实际传输的证明。插件进程日志不能直接当作本会话的精确失败次数。

已修复两处诊断缺陷：

1. [运行时](<../src/pi-ai-runtime.js>)在 payload hook 完成后回到 request 阶段，发送失败不再误报为构建 payload 失败。
2. [网络封装](<../src/oauth-network.js>)在 SDK 丢失 Error.cause 前观察错误；[白名单摘要](<../src/transport-failure.js>)只记录 ECONNRESET、UND_ERR_SOCKET 等已知代码，不记录消息、地址、凭据或请求正文。观察失败不改变原异常，不新增重试。

两个不带凭据的 GET 连通性探测（Node fetch / https）均收到 401；未调用模型。这只证明当时链路可达，不能排除间歇故障。当前错误根因尚不能确定为 DNS、TLS、代理、WebSocket 或服务端行为。没有修改连接模式、代理、超时或重试次数。

## 测试与交付状态

- 聚焦测试：原生协议/SSE/缓存/SDK + 网络诊断 + 现有相关网络测试，59 项通过；随后新增 socket 测试单独通过（合计 60）。
- 实际安装 pi-ai 1.1.0 的模拟 socket 验证通过；实际 DSH rc.3 的十项隔离路由检查通过。
- 包级回归（添加 socket 测试前）：1363 项，1356 通过、6 跳过、1 失败。唯一失败是改动前已独立复现的 [Windows Unicode 路径卸载测试](<../tests/powershell-manager.test.mjs#L376-L396>)。
- 构建通过，git diff --check 通过。生成的 [服务端构建](<../lib/index.js>)包含诊断修复；原生验证模块未接入生产入口。
- **未发布、未安装到正在使用的插件、未修改 DSH 核心、未重启当前进程。**

建议下一步先经用户确认部署诊断修复，以正常会话的一次真实失败收集底层错误码；重连问题与原生压缩接入分别验收。
