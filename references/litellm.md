# LiteLLM 如何实现统一模型调用

研究基准：LiteLLM 官方仓库 [`09ebb28473e6e9e09c80ce2f822b88d8bc24f2e4`](./litellm/README.md)（2026-09-24）。以下区分官方功能说明与该提交中可见的实现；不同版本与部署配置可能有差别。

## 核心机制

LiteLLM 不是自己训练并运行一个通用大模型。它主要是**多模型调用适配层 + 可部署的 API 网关**：Python SDK 让应用直接调用统一的 `completion(model, messages, ...)`；Proxy 则提供 `/v1/chat/completions` 等 OpenAI 风格的 HTTP 入口，故现有 OpenAI 客户端通常只需改 `base_url`、密钥和模型配置即可接入。所谓“100+ 模型提供商”是[官方项目说明](./litellm/README.md#what-is-litellm)的支持范围声明，不是对每个模型和功能组合的兼容性保证。[SDK 和代理示例](./litellm/README.md#L82-L124) · [HTTP 端点源码](./litellm/litellm/proxy/proxy_server.py#L11456-L11538)

典型路径：`客户端 -> Proxy 鉴权/模型权限/预算 -> Router 选择部署、重试或回退 -> SDK 按提供商转换请求并调用上游 API -> 转换返回值、记录用量/费用 -> 响应客户端`。直接使用 SDK 时，不经过 Proxy 的虚拟密钥等网关步骤。[代理请求处理](./litellm/litellm/proxy/common_request_processing.py#L2593-L2615) · [代理选择 Router](./litellm/litellm/proxy/route_llm_request.py#L426-L490)

1. **适配供应商协议。** SDK 从模型名或显式配置推断提供商，分派到 OpenAI、Anthropic、Gemini 等各自处理器；例如 Anthropic 适配器把统一的消息和可选参数转成其请求格式，又将返回的内容、工具调用、结束原因和用量映射到统一的 `ModelResponse`。这是一组按供应商编写的转换器，不等于所有原生能力都能无损映射。[提供商推断](./litellm/litellm/main.py#L5408-L5430) · [提供商分派](./litellm/litellm/main.py#L5868-L5934) · [Anthropic 请求/响应转换](./litellm/litellm/llms/anthropic/chat/transformation.py#L1888-L1906) · [响应映射](./litellm/litellm/llms/anthropic/chat/transformation.py#L2630-L2664)
2. **路由与容错。** `Router` 把对外模型名映射为一组可用部署，过滤不健康、冷却或被限制的部署，再按配置策略选择，例如默认 `simple-shuffle` 的加权随机分配；调用失败可先重试，之后依配置回退到其他模型组。另有按成本、延迟、忙碌程度或用量选路的策略，故“自动选最优模型”应理解为**特定策略下的选择**，不是通用质量评估。[配置项](./litellm/litellm/router.py#L769-L849) · [部署筛选与选择](./litellm/litellm/router.py#L13985-L14121) · [重试/回退](./litellm/litellm/router.py#L7442-L7510)
3. **代理治理。** HTTP 端点使用 FastAPI 鉴权依赖，支持虚拟密钥等身份来源，鉴权后统一检查路由/模型权限和预算；预算检查及请求预算预留写在授权调用链中，RPM/TPM 限速还有独立的请求前钩子。因此网关可按密钥、用户/团队及模型控制访问和开销，这些不是 SDK `completion()` 的必经步骤。[端点依赖](./litellm/litellm/proxy/proxy_server.py#L11456-L11481) · [鉴权/授权](./litellm/litellm/proxy/auth/user_api_key_auth.py#L3288-L3351) · [预算校验与预留](./litellm/litellm/proxy/auth/user_api_key_auth.py#L2319-L2335) · [预留实现入口](./litellm/litellm/proxy/auth/user_api_key_auth.py#L3073-L3113) · [限速钩子](./litellm/litellm/proxy/hooks/dynamic_rate_limiter.py#L182-L226)
4. **可选的缓存与观测。** 缓存层按请求生成键，可接内存、Redis、磁盘等后端，命中时免去重复上游调用；日志/回调记录响应、失败、流式事件和费用，费用计算读取模型价格与用量。缓存和外部观测集成需要适当配置，并非对所有请求无条件启用。[缓存实现](./litellm/litellm/caching/caching.py#L186-L287) · [命中逻辑](./litellm/litellm/caching/caching.py#L608-L650) · [代理前后钩子](./litellm/litellm/proxy/common_request_processing.py#L2576-L2605) · [费用计算](./litellm/litellm/cost_calculator.py#L369-L495)

要点：跨厂商一致性靠**协议和数据结构转换**，多部署可靠性靠**可配置 Router**，团队管控靠**代理层**；LiteLLM 仍需要上游模型服务/凭证或用户自己部署的模型 API。
