# 基于 Jev 的自动路由可行性研究

调研日期：2026-09-30

## 结论

**当前可以实现一个基于 Jev 的自动路由策略，但它是“远程语义判定 + 本地确定性排序”的策略插件，不是 Router 已内置的能力。** 现有 `RoutingPolicy.rank` 已经提供了最小的决策插口：接收一个 `GenerationRequest` 和已经筛选过的候选 deployment，返回候选的有序子集。Jev 的 `Choice` 概率分布可以用来排序候选，`Score` 可以用来评估请求难度/风险，`Noul` 可以作为是否升级或是否允许自动路由的门槛。

不过，当前契约对“策略需要外部服务”表达得不够完整：`RoutingPolicy.rank` 的返回类型没有 `Requirements` 泛型，而 deployment、pipeline、middleware 和 `start` 都可以声明资源需求。因此，生产级 Jev 策略需要在插件外闭包持有一个客户端，或先扩展 core 让 policy 显式声明并获得 `HttpClient`/Jev client service。否则容易把网络 I/O、超时和错误映射藏在未类型化的闭包中。

建议把落地分成两层：

1. **PoC**：固定一组候选，将请求文本和候选描述投影成 Jev `Choice`，调用远程 API，校验返回的候选 ID 和概率，再把 Jev 选中的 deployment 放在 fallback 列表首位。
2. **生产集成**：增加可注入的 Jev client/service、请求超时和本地 deterministic fallback；记录模型版本、概率、confidence、Jev 延迟、provider 结果和最终路由，使用业务数据做离线评估后再调整问题定义和阈值。

这意味着“能不能实现”的答案是**能**，但当前仓库可以直接承载的是策略逻辑，不能直接声称已经具备 Jev 的 SDK、资源注入、观测和反馈闭环。

## Jev 是什么

TypeSafe 将 Jev 定义为第一个 System One Model。它接受一份 `state`，对一个或多个预先定义的 typed question 作判断，并返回结构化答案、概率分布和（Choice/Score）confidence；它不是面向人类输出长文本的 LLM。官方文档明确列出三种 primitive：

- `Choice`：在给定选项中选择一个，返回 `choice`、每个选项的 `probabilities` 和 `confidence`。
- `Score`：按有序 rubric 评分，返回概率加权的 `score`、各级别概率和 `confidence`。
- `Noul`：判断一个 yes/no 命题，返回 0 到 1 的 `noul` 概率；它不带单独的 confidence 字段。

同一个请求中的问题针对同一 state 独立并行评估。官方因此建议把 intent、难度、风险等问题放在一个请求中，再由业务代码组合答案，而不是让一个生成式模型在自由文本中完成整棵决策树。

这不是把 Jev 用作通用文本生成器的推断：TypeSafe 的官方 use-case map 直接把“custom router that chooses which LLM receives each prompt”、按规则/阈值升级到更昂贵模型列为 Model routing 用例；因此“Jev 作为路由判定器”属于其公开定位内的用途。

来源：[`System One` 文档](https://docs.typesafe.ai/concepts/system-one)、[`Introduction` 文档](https://docs.typesafe.ai/introduction)、[`Primitives` 文档](https://docs.typesafe.ai/primitives)、[`Example use cases / Model routing`](https://docs.typesafe.ai/concepts/use-case-map)、[`Speculative fan-out` 模式](https://docs.typesafe.ai/patterns/fan-out)。

## 输入、输出和 API

### HTTP API

官方 HTTP API 是：

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

请求至少包括：

```json
{
	"state": "...",
	"model": "jev-latest",
	"questions": {
		"deployment": {
			"type": "choice",
			"instructions": "Which candidate is the best fit for this request?",
			"criteria": {
				"primary": "...",
				"backup": "..."
			}
		}
	}
}
```

`state` 可以是字符串、JSON object 或 array；`instructions` 和 criteria 也可以是结构化 JSON。Choice 最多 255 个选项，Score 最多 10 个级别。响应在相同 question ID 下返回答案，并附带实际使用的 model ID 和 `usage.input_tokens`/`usage.output_tokens`。Choice/Score 的概率浮点数近似和为 1；Choice 的 `choice` 是最高概率选项，Score 的 `score` 是概率加权期望值。

完整字段和错误由官方 API 文档及 OpenAPI 所有者定义：[`API reference`](https://docs.typesafe.ai/api)、[`OpenAPI 3.1`](https://api.typesafe.ai/openapi.json)。文档列出的错误包括 401、422、429 和 529；429/529 应退避重试。

### SDK 和运行时

官方 JavaScript SDK 的默认地址是 `https://api.typesafe.ai`，默认模型是 `jev-latest`；`systemOne` 调用固定发送到 `/v1/systemone`。SDK 支持自定义 `baseURL`、每次调用的 timeout、AbortSignal 和 retry policy；文档默认每次尝试 timeout 为 10 秒，默认最多重试 2 次，重试 408、429 和 5xx。参考 [`TypeSafeClientConfig`](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig)、[`RequestOptions`](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RequestOptions)、官方 SDK 源码 [`client.ts`](https://github.com/typesafe-ai/typesafe-sdk-js/blob/66880ccded6cb642dc1809620c2b108c33730214/src/client.ts) 和 [`retry.ts`](https://github.com/typesafe-ai/typesafe-sdk-js/blob/66880ccded6cb642dc1809620c2b108c33730214/src/retry.ts)。

Python SDK 也支持 `base_url` 指向遵循 TypeSafe OpenAPI 的兼容服务，官方文档以 OpenRouter 为例。这是“调用远程兼容 API”的能力，不等于 Jev 权重可下载或可在本地推理：当前公开文档只描述 API/SDK 服务，没有本地 Jev 权重、离线 runtime 或自托管部署说明。另一个 `system-one-adapter-python` 仓库是把 OpenAI/Anthropic/Gemini 等普通 LLM 适配成 System One 输出形状的兼容层；它不提供 Jev 本身，不能把它的结果和 Jev 的延迟、校准或模型质量等同。来源：[`Python SDK usage`](https://docs.typesafe.ai/sdk/python/usage)、[`system-one-adapter-python README`](https://github.com/typesafe-ai/system-one-adapter-python)。

### 输入边界

Jev 1.13 的输入是文本：字符串、JSON object 或 text array；官方模型页说明目前不接受 image/audio/video。当前 better-router 的 `GenerationRequest.input` 可以包含文本、图片、文件、视频和其他 item，因此 Jev 路由策略必须先做投影：

- 纯文本 item 可以保留为结构化 state；
- 图片、音频、视频、文件等要么由宿主预处理成文本/特征，要么显式标记为“Jev 不可判定”，不能静默丢弃后继续做高风险路由；
- 应只发送判定所需的相关字段。Jev 官方明确警告，state 中无关内容会造成 context rot；用户输入还应按不可信数据处理并测试 prompt injection/adversarial content。

来源：[`State` 文档](https://docs.typesafe.ai/concepts/state)、[`Models` 文档](https://docs.typesafe.ai/models)、[`Jev 1.13 jaggedness`](https://docs.typesafe.ai/model-jaggedness/jev-1.13)。

## 和当前 Router 契约的对照

当前仓库的最小路由面如下：

```ts
interface RoutingPolicy<Id extends string = string> {
	readonly id: Identifier<Id>
	readonly rank: (
		request: GenerationRequest,
		candidates: readonly DeploymentRef[],
	) => Effect.Effect<readonly DeploymentRef[], RoutingError>
}
```

见 [`Routing.ts`](../../packages/core/src/Routing.ts#L43-L49)。`Router` 会先按 route 选出配置的 deployment，再按 required upstream transport 过滤，之后调用 policy；返回值只能是 eligible deployment 的无重复有序子集，Router 会拒绝未知或重复 ID。见 [`Router.ts`](../../packages/core/src/Router.ts#L310-L370)。没有 policy 时，route 中的 deployment 顺序就是 fallback 顺序（见 [`Routing.ts`](../../packages/core/src/Routing.ts#L12-L15)）。

因此，一个 Jev policy 可以实现下面的确定性流程：

```text
GenerationRequest + eligible DeploymentRef
  -> 投影成 { request_state, candidates }
  -> Jev Choice/Score/Noul（远程调用）
  -> Schema 解码 + ID/概率/confidence 校验
  -> 按概率/综合分数排序，保留未选候选作为 fallback
  -> 返回 DeploymentRef[]
  -> Router 执行首选 deployment
```

Router 的 provider fallback 仍然由本地执行链控制：只有 `ProviderError.retryable` 且还没有发出第一个 generation event 时才尝试下一个 deployment；Jev 发生在 ranking 阶段，若 policy 直接失败，Router 会返回 `RoutingFailed`，不会自动把 policy 错误当成 provider fallback。见 [`Router.ts`](../../packages/core/src/Router.ts#L340-L410)。策略应自行决定 Jev 超时、429/529、无效响应时是回退到原始 eligible 顺序（fail-open）、拒绝请求（fail-closed）还是走单独的保守 deployment。

当前 `DeploymentRef` 只有 `id`、`provider`、`model`，没有价格、延迟、上下文窗口、实时健康度或能力集合；这些字段不能凭空让 Jev 判断。若路由要使用成本/延迟/健康度，需要由插件配置一个不可变候选目录，或新增 typed service/metadata，并在投影中显式提供给 Jev。当前 `GenerationRequest` 还包含多模态 input、tools、sampling、reasoning 等字段；不应把完整对象未经筛选地序列化给 Jev。见 [`Deployment.ts`](../../packages/core/src/Deployment.ts#L18-L25) 和 [`Generation.ts`](../../packages/core/src/Generation.ts#L337-L365)。

另一个集成边界是资源注入。`RouterPlugin` 的 `deployments`、`pipelines`、`middleware` 和 `start` 可以带 `Requirements`，但 `RoutingPolicy.rank` 本身没有对应的环境泛型。见 [`Plugin.ts`](../../packages/core/src/Plugin.ts#L52-L75)。这使“通过 Router 的 `HttpClient` service 调用 Jev”在类型上不如 deployment executor 清晰；更稳妥的 core 方向是为 policy 增加 requirements（或定义一个专用 `RoutingService`），并让 Router 在执行 rank 时提供该环境。未改 core 的 PoC 可以把已经构造好的客户端闭包传给 policy，但应把超时、凭证、重试、Schema 解码和脱敏放在独立边界中。

## 可行的 Jev 路由形态

### 1. 单 Choice 选择首选 deployment

把每个候选 deployment 编成 Choice 的 option，option key 必须是稳定的 deployment ID，criteria 描述模型/provider 的静态能力。返回后按 `probabilities` 降序排序；把最高概率候选置首位，其余候选按原 fallback 顺序或概率排序，避免低 confidence 时把所有安全 fallback 丢掉。

```text
Choice criteria:
  openai_fast: "低延迟、短上下文、适合普通请求"
  anthropic_reasoning: "复杂推理、较高成本、可接受更高延迟"

questions:
  deployment: "Which candidate best fits this request?"
```

实现时必须检查：返回的 option 是否属于本次 `eligible` 集合、概率是否有限且在 [0,1]、是否存在 ties、confidence 是否低于本地阈值。Jev 的 `choice` 字符串不能未经白名单校验直接索引 deployment。

### 2. Choice + Score 组合

一次请求同时问：

- `intent`：请求类别；
- `difficulty`：难度或所需推理级别；
- `risk`：错误代价；
- `deployment`：候选适配度。

代码可将 Score 归一化后与概率/成本权重组合，例如 `fit - costPenalty - latencyPenalty`。这符合 TypeSafe 的 composite scoring/intent routing 建议，且不会把业务权重埋在 Jev 的 prompt 中。高风险场景应把低 confidence 路由到人工、保守模型或二次验证，而不是强行选择最高概率项。

来源：[`Intent routing`](https://docs.typesafe.ai/patterns/intent-routing)、[`Confidence-gated routing`](https://docs.typesafe.ai/patterns/confidence-routing)、[`Composite scoring`](https://docs.typesafe.ai/patterns/composite-scoring)。

### 3. Noul 作为升级门

例如先问“该请求是否需要复杂推理/高风险处理”，若 `noul` 超过经过业务数据校准的阈值，再把候选限制到 reasoning deployment。Noul 没有 confidence，不能把它和 Choice 的 confidence 直接互换；官方还警告不要假设两个独立 Noul 之间存在算术互补关系。

## 延迟、成本和可用性

TypeSafe 发布文章声称 Jev 的端到端响应时间约为 70–500ms，相比其对比的 frontier LLM 约 3–329 秒，在 System One 形状的任务上可快 40–200 倍；官方文档在通用描述中写“多数查询约 100ms”。这些是 TypeSafe 的产品/演示数据，不是 better-router 的 SLA，也不包括本地状态投影、网络往返、SDK 重试和 Router 自身执行时间。来源：[`Introducing System One Models & Jev`](https://typesafe.ai/blog/introducing-system-one-models-and-jev)、[`How to build with System One`](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)。

当前模型页列出 Jev 1.13 的 64k 总 context（state + questions），state 加最长问题有 32k 限制，输入仅文本；公开限额为 250,000 tokens/s 和 1,200 requests/min，且可能动态调整。`jev-latest` 是可移动 alias；如果阈值依赖某个版本，应记录并固定 `jev-1.13.0`，因为 alias 更新可能改变答案。来源：[`Models`](https://docs.typesafe.ai/models)。

对 Router 来说，远程 Jev 是每次请求前增加的一次网络判定。建议：

- 使用远低于 SDK 默认 10 秒的 policy timeout，并设置总预算；
- 将 429、529、连接失败、Schema 解码失败统一映射为可观察的 `RoutingError`；
- 对 Jev 不可用做本地 fallback，不要让路由服务整体不可用；
- 记录 Jev request/response model、usage、latency、selected deployment 和 provider outcome；
- 对同一请求不要在 fallback 每一步重复调用 Jev，除非候选集合确实变化且预算允许。

## 训练、配置和反馈闭环

Jev 的训练方向是 RLCD（Reinforcement Learning for Calibrated Decisions），目标是输出决策和校准概率，而不是生成文本。官方解释的校准是群体层面的：概率为 0.8 的一组预测约有 80% 正确，不保证单个请求一定正确。`confidence` 是概率分布形状的统计摘要，Choice/Score 可用于阈值控制；阈值必须依据具体业务风险和自有数据调校。

Jev 不提供客户级 fine-tune 或 LoRA；官方模型页说相同权重服务所有账户。领域配置通过每次请求的 state、instructions 和 criteria 完成；复杂判断应拆成多个 atomic questions，再由代码组合。Jev 1.13 的公开 jaggedness 文档还明确建议把数学、计数、日期比较和结构不变量留给代码，并避免大而无关的 state。

公开 API/SDK 响应包含 model、answers 和 token usage，但没有“将本次路由结果作为在线训练反馈”的 API，也没有 provider 成功率/成本等自动反馈给 Jev。可行的闭环是宿主自行保存：

```text
请求 state + questions
  -> Jev probabilities/confidence + 选择
  -> provider 实际成功/错误、延迟、成本、用户/评测结果
  -> 离线评估（按模型版本和业务分桶）
  -> 调整 criteria、代码权重、confidence threshold 或候选配置
```

官方建议用户为自己的 use case 做 workflow eval，而不是只看公开 benchmark；这意味着 Jev route policy 必须有一套 replay/eval 数据，尤其要测不同语言、长 state、prompt injection、候选描述变化和 provider 退化。来源：[`AI primer`](https://docs.typesafe.ai/introduction/machine-learning-primer)、[`Confidence`](https://docs.typesafe.ai/confidence)、[`Models`](https://docs.typesafe.ai/models)、[`Jev 1.13 jaggedness`](https://docs.typesafe.ai/model-jaggedness/jev-1.13)、发布文章中的 workflow eval 段落。

## 风险与边界

| 风险                        | 对自动路由的影响                                      | 缓解                                                                        |
| --------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------- |
| 远程 Jev 不可用、限流或超时 | ranking 阶段失败；当前 Router 不会自动跳过失败 policy | policy 内置 deterministic fallback；独立超时/重试预算；观测 `RoutingError`  |
| confidence 低或候选接近     | 选中的 deployment 不稳定                              | 低 confidence 走保守 deployment/人工；保留原 fallback；用 replay 数据定阈值 |
| 文本-only                   | 图片/音频/视频请求无法直接被 Jev 判断                 | 宿主预处理或按能力显式降级；不要静默丢字段                                  |
| state 太大或含无关信息      | context rot，语义判定质量下降                         | 先在代码中过滤、截断和结构化；只发送问题需要的字段                          |
| 用户输入 prompt injection   | 候选选择可能被恶意文本影响                            | 将 state 视为不可信数据；在 criteria 中明确定义选项；做攻击样本测试         |
| alias 漂移                  | 同一阈值下行为改变                                    | 记录 response.model；稳定阈值时固定 versioned model ID                      |
| 私有 provider 元数据        | 把 URL、凭证或内部成本信息放进 state 可能泄露         | 只发送最小候选描述和不敏感标签；脱敏并限制日志                              |

## 最终判断

在不改生产代码的前提下，可以把 Jev 当作一个**外部、低延迟、结构化的 ranking oracle**，由一个 `policies` 插件调用并返回现有 Router 能接受的 deployment 顺序。这已经足以验证“按请求语义选择模型”的价值。

若要把它作为 better-router 的长期能力，至少应补齐：

1. policy 的 typed external requirements（Jev client、HTTP transport、clock/metrics）；
2. 候选 deployment 的可选静态 capability/cost/latency 元数据和健康状态读取；
3. Jev 请求/响应 Schema、超时/重试/降级策略和脱敏日志；
4. route decision 的 confidence/probability/版本观测与离线 replay/eval；
5. 明确远程 Jev-only 部署边界，不把 OpenAI/Anthropic/Gemini 的 adapter 当成本地 Jev。

这些是集成工程和可靠性工作，不是 Jev 模型本身的训练工作。

## 主要来源

- TypeSafe AI：[Introducing System One Models & Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- TypeSafe 官方文档：[Introduction](https://docs.typesafe.ai/introduction)、[System One](https://docs.typesafe.ai/concepts/system-one)、[API reference](https://docs.typesafe.ai/api)、[OpenAPI](https://api.typesafe.ai/openapi.json)、[Models](https://docs.typesafe.ai/models)
- 输入与决策模式：[State](https://docs.typesafe.ai/concepts/state)、[Confidence](https://docs.typesafe.ai/confidence)、[Intent routing](https://docs.typesafe.ai/patterns/intent-routing)、[Confidence-gated routing](https://docs.typesafe.ai/patterns/confidence-routing)、[Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out)、[Example use cases / Model routing](https://docs.typesafe.ai/concepts/use-case-map)
- 限制与训练：[AI primer](https://docs.typesafe.ai/introduction/machine-learning-primer)、[Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
- 官方客户端/兼容层：[TypeSafe JavaScript SDK](https://github.com/typesafe-ai/typesafe-sdk-js/tree/66880ccded6cb642dc1809620c2b108c33730214)、[TypeSafe Python SDK](https://github.com/typesafe-ai/typesafe-sdk-python/tree/f078f1e208a0d885154dc758344ae4fce77ac168)、[system-one-adapter-python](https://github.com/typesafe-ai/system-one-adapter-python/tree/e1d4cc938204b22fc5a3c3aca7044072fe3f712d)
- better-router 当前契约：[`Routing.ts`](../../packages/core/src/Routing.ts)、[`Router.ts`](../../packages/core/src/Router.ts)、[`Deployment.ts`](../../packages/core/src/Deployment.ts)、[`Plugin.ts`](../../packages/core/src/Plugin.ts)、[`architecture.md`](../architecture.md)
