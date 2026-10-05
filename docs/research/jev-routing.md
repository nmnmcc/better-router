# 基于 Jev 的自动路由可行性研究

调研日期：2026-09-30

Router 契约更新日期：2026-10-05。下文的 TypeSafe API、模型和限额仍是调研日期的来源快照；本次更新只对齐仓库的插件与路由契约，没有调用 Jev 服务，也没有重新验证其最新发布状态。

## 结论

当前可以实现一个基于 Jev 的自动路由插件：用远程服务判断语义，再由本地代码确定候选顺序。仓库没有内置 Jev 客户端或策略。`Plugin.config.policies` 中的 `RoutingPolicy.rank` 接收 `GenerationRequest`、已经筛选过的候选 deployment 和策略上下文，返回候选的有序子集；`config.pipelines` 则可以收窄 `RoutingContext.candidateDeployments` 并添加不可变 signals。Jev 的 `Choice` 概率分布可以用来排序候选，`Score` 可以用来评估请求难度/风险，`Noul` 可以作为是否升级或是否允许自动路由的门槛。

策略和 pipeline 的 Effect 已带 `Requirements` 泛型，外部 Jev service 应由插件 `layer` 或宿主 Layer 注入。稳定的路由能力声明放在 `capabilities`，候选目录、policy/pipeline 和阈值放在 `config`；客户端、凭证、超时和观测服务放在运行时环境。`init` 负责 scoped 资源初始化，不能在启动时追加候选或修改静态 Registry。

建议把落地分成两层：

1. **PoC**：固定一组候选，将请求文本和候选描述投影成 Jev `Choice`，调用远程 API，校验返回的候选 ID 和概率，再把 Jev 选中的 deployment 放在 fallback 列表首位。
2. **生产集成**：增加可注入的 Jev client/service、请求超时和本地 deterministic fallback；记录模型版本、概率、confidence、Jev 延迟、provider 结果和最终路由，使用业务数据做离线评估后再调整问题定义和阈值。

现有插件接口可以承载上述策略和 typed service 注入，但 Jev 请求/响应 Schema、客户端 Layer、专用观测和离线评估仍需实现，不能把通用插件接口视为已经完成 Jev 集成。

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

### SDK 和运行时（调研日期快照）

官方 JavaScript SDK 的默认地址是 `https://api.typesafe.ai`，默认模型是 `jev-latest`；`systemOne` 调用固定发送到 `/v1/systemone`。SDK 支持自定义 `baseURL`、每次调用的 timeout、AbortSignal 和 retry policy；文档默认每次尝试 timeout 为 10 秒，默认最多重试 2 次，重试 408、429 和 5xx。参考 [`TypeSafeClientConfig`](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig)、[`RequestOptions`](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RequestOptions)、官方 SDK 源码 [`client.ts`](https://github.com/typesafe-ai/typesafe-sdk-js/blob/66880ccded6cb642dc1809620c2b108c33730214/src/client.ts) 和 [`retry.ts`](https://github.com/typesafe-ai/typesafe-sdk-js/blob/66880ccded6cb642dc1809620c2b108c33730214/src/retry.ts)。

Python SDK 也支持 `base_url` 指向遵循 TypeSafe OpenAPI 的兼容服务，官方文档以 OpenRouter 为例。这是“调用远程兼容 API”的能力，不等于 Jev 权重可下载或可在本地推理：当前公开文档只描述 API/SDK 服务，没有本地 Jev 权重、离线 runtime 或自托管部署说明。另一个 `system-one-adapter-python` 仓库是把 OpenAI/Anthropic/Gemini 等普通 LLM 适配成 System One 输出形状的兼容层；它不提供 Jev 本身，不能把它的结果和 Jev 的延迟、校准或模型质量等同。来源：[`Python SDK usage`](https://docs.typesafe.ai/sdk/python/usage)、[`system-one-adapter-python README`](https://github.com/typesafe-ai/system-one-adapter-python)。

### 输入边界

Jev 1.13 的输入是文本：字符串、JSON object 或 text array；官方模型页说明目前不接受 image/audio/video。当前 better-router 的 `GenerationRequest.input` 可以包含文本、图片、文件、视频和其他 item，因此 Jev 路由策略必须先做投影：

- 纯文本 item 可以保留为结构化 state；
- 图片、音频、视频、文件等要么由宿主预处理成文本/特征，要么显式标记为“Jev 不可判定”，不能静默丢弃后继续做高风险路由；
- 应只发送判定所需的相关字段。Jev 官方明确警告，state 中无关内容会造成 context rot；用户输入还应按不可信数据处理并测试 prompt injection/adversarial content。

来源：[`State` 文档](https://docs.typesafe.ai/concepts/state)、[`Models` 文档](https://docs.typesafe.ai/models)、[`Jev 1.13 jaggedness`](https://docs.typesafe.ai/model-jaggedness/jev-1.13)。

## 和当前 Router 契约的对照

插件的 effectful policy 使用以下决策边界；完整声明以 [`PluginContributions.ts`](../../packages/core/src/PluginContributions.ts) 为准：

```ts
type JevRank<Requirements> = (
	request: GenerationRequest,
	candidates: readonly DeploymentRef[],
	context: PolicyContext,
	routing?: RoutingContext,
) => Effect.Effect<readonly DeploymentRef[], JevError, Requirements>

type JevPipeline<Requirements> = (
	context: RoutingContext,
) => Effect.Effect<RoutingContext, JevError, Requirements>

const config = {
	policies: [jevPolicy],
	pipelines: [jevSignals],
	modelRoutes: [modelRoute],
}
```

这里的 `JevError` 是集成插件应定义的 Schema 错误，`jevPolicy`、`jevSignals` 和 `modelRoute` 是集成示意，不是仓库已导出的 Jev 对象。只需要选择首选 deployment 时可只贡献 policy；需要把难度、风险或 confidence 传给后续策略时可贡献 pipeline。候选结果必须是本次 eligible 集合的无重复子集，不能用 Jev 返回的字符串创建新 deployment。候选为空和未知/重复 ID 都是 typed routing failure。见 [`Routing.ts`](../../packages/core/src/Routing.ts) 和 [`Policies.ts`](../../packages/core/src/Policies.ts)。配置的 `simple` strategy 保留候选声明顺序；其他内置策略可使用权重、成本或运行时 metrics。

因此，一个 Jev policy 可以实现下面的确定性流程：

```text
RoutingContext + eligible DeploymentRef
  -> 投影成 { request_state, candidates }
  -> Jev Choice/Score/Noul（远程调用）
  -> Schema 解码 + ID/概率/confidence 校验
  -> policy 返回有序子集 / pipeline 返回 candidates 和 signals
  -> 本地健康、权限、预算与能力检查
  -> Router 执行首选 deployment
```

Provider fallback 仍由本地执行链和 route retry policy 控制。只有满足重试条件且还没有发出第一个语义 generation event 时，才能尝试下一 deployment；已经输出事件后不能重放。见 [`Routing.ts`](../../packages/core/src/Routing.ts)、[`RoutingRuntime.ts`](../../packages/core/src/RoutingRuntime.ts) 和 [`Router.ts`](../../packages/core/src/Router.ts)。Jev 失败发生在选路阶段，不能自动解释为一次 provider attempt 失败。策略应明确选择 Jev 超时、429/529、无效响应时是保留原始 eligible 顺序、拒绝请求还是限制到一个保守候选。任何降级仍必须满足原候选的能力、访问权限和预算限制。

候选 identity 包含 `id`、`provider` 和 `model`；路由候选还可带权重、tags、价格和 limits。`PolicyContext`/`RoutingContext` 的 metrics 提供 active requests、已观测延迟和成功/失败计数，signals 提供前序 pipeline 的判定结果。静态能力来自 Capability/Provider Contract，健康度和 cooldown 来自运行时服务；Jev 只能使用集成插件明确投影的字段，不能推断缺失的上下文窗口或未观测延迟。见 [`Deployment.ts`](../../packages/core/src/Deployment.ts)、[`Policies.ts`](../../packages/core/src/Policies.ts)、[`RoutingRuntime.ts`](../../packages/core/src/RoutingRuntime.ts) 和 [`ProviderContract.ts`](../../packages/core/src/ProviderContract.ts)。`GenerationRequest` 包含多模态 input、tools、sampling、reasoning 等字段；不应把完整对象未经筛选地序列化给 Jev。见 [`Generation.ts`](../../packages/core/src/Generation.ts)。

资源注入通过 `Plugin.layer` 和 `init` 接入。`Router.make` 先纯构造静态配置，`Router.runtime` 在 Scope 中装配服务并启动插件，`Router.layer` 把 runtime 暴露给宿主；policy/pipeline 的服务需求必须沿类型传到这条装配路径。见 [`Plugin.ts`](../../packages/core/src/Plugin.ts) 和 [`Router.ts`](../../packages/core/src/Router.ts)。Jev client 应作为独立 Effect service 管理 HTTP、凭证、超时、重试、Schema 解码和脱敏，不能把 I/O 或 secret 埋进 Capability。宿主若记录路由反馈，可使用独立 Persistence Layer；持久化候选判定和脱敏结果，不保存 Jev 明文 API key 或完整敏感输入。

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

调研日期的模型页列出 Jev 1.13 的 64k 总 context（state + questions），state 加最长问题有 32k 限制，输入仅文本；公开限额为 250,000 tokens/s 和 1,200 requests/min，且可能动态调整。`jev-latest` 是可移动 alias；如果阈值依赖某个版本，应记录并固定 `jev-1.13.0`，因为 alias 更新可能改变答案。来源：[`Models`](https://docs.typesafe.ai/models)。

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

可以把 Jev 当作外部的结构化决策服务，由对象插件通过 `config.policies` 或 `config.pipelines` 贡献路由判定，并用 Layer 注入客户端。这条集成路径足以验证按请求语义选择模型，但仓库没有提供 Jev 实现。

若要把它作为 better-router 的长期能力，至少应补齐：

1. Jev client Layer 及其 HTTP transport、clock/metrics 的 typed requirements；
2. 将现有候选 metadata、runtime metrics 和能力目录投影成 Jev 的最小输入；
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
