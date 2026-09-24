# OpenCode V2 的插件 Interface：Effect 如何进入宿主

研究基准：`references/opencode` 中 OpenCode 源码提交 `6608799d35d96c2821a48ac1d4b26a3b84b4e433`（2026-09-24）。本文描述此提交的**现行代码**；`packages/plugin/src/effect/PLAN.md` 明确是目标设计/实施计划，不能替代当前接口和运行时。[计划状态](./opencode/packages/plugin/src/effect/PLAN.md#L1-L20) · [现行签名](./opencode/packages/plugin/src/effect/registration.ts#L12-L27)

## 一句话模型

Effect 插件是一个默认导出的 `{ id, effect(ctx) }` 对象。`Plugin.define` 只是泛型透传，`effect` 是安装阶段运行一次的 `Effect.Effect<void, never, R>`，默认环境需求 `R = Scope.Scope`；它**不返回 hooks**。插件在 `ctx` 的领域能力上主动注册 `transform`（可重放的状态编辑）和 `hook`（实时操作拦截），并通过 scoped registration 的 `dispose` 或作用域关闭撤销。[公共定义](./opencode/packages/plugin/src/effect/plugin.ts#L26-L63) · [注册类型](./opencode/packages/plugin/src/effect/registration.ts#L1-L27) · [官方示例](./opencode/packages/plugin/src/effect/README.md#L8-L30)

```ts
import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"

export default Plugin.define({
  id: "example",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.agent.transform((editor) => {
      editor.update("reviewer", (agent) => { agent.description = "Review changes" })
    })
    yield* ctx.session.hook("context", (event) =>
      Effect.sync(() => {
        if (event.tools.read) event.tools.read.description = "Read file ranges"
      }),
    )
  }),
})
```

示例中的 `agent.transform` 和 `session.hook` 都先产生**注册用的 Effect**，所以安装时需要 `yield*`；前者收到同步 editor，后者回调返回 Effect。[Transform/Hooks 类型](./opencode/packages/plugin/src/effect/registration.ts#L12-L27) · [Agent 编辑器](./opencode/packages/plugin/src/effect/agent.ts#L6-L17) · [Session context](./opencode/packages/plugin/src/effect/session.ts#L33-L36) · [示例](./opencode/packages/plugin/src/effect/README.md#L83-L125)

## 公共 Interface 与 Effect 边界

- `@opencode/plugin` 是 Promise 入口，`@opencode/plugin/effect` 是独立 Effect 入口；后者导出 `Plugin` 命名空间和共享 schema 类型。`Plugin.Context` 是**按领域收敛的能力对象**，含 `app`、`location`、`options`、`agent`、`model`、`provider`、`session`、`tool`、`event`、`storage`、`rpc` 等，并非把整个 Core 容器交给插件。`options` 当前为 `Readonly<Record<string, any>>`，没有依据插件 ID 自动推导配置类型。[包导出](./opencode/packages/plugin/package.json#L12-L17) · [Effect 出口](./opencode/packages/plugin/src/effect/index.ts#L1-L19) · [Context](./opencode/packages/plugin/src/effect/plugin.ts#L26-L54) · [选项类型](./opencode/packages/plugin/src/options.ts#L1)
- 领域里的常规读取/操作复用生成的 `@opencode/client/effect/api` 签名，再补插件专用的编辑和重载。例如 `ProviderDomain extends ProviderApi<unknown>` 并增加 `transform/reload`；生成的 `ProviderApi` 定义 `list/get` 为返回 `Effect` 的操作。`SessionDomain` 刻意 `Pick` 部分客户端方法，再加 `hook`；`ToolDomain` 则是插件专用的 transform/list/hook。Core 的 `PluginHost.make` 把这些公开能力映射到 location 内部服务，并对 ID、响应封装和编辑器做适配。[插件包约定](./opencode/packages/plugin/AGENTS.md#L1-L5) · [Provider 域](./opencode/packages/plugin/src/effect/provider.ts#L30-L33) · [生成的 API](./opencode/packages/client/src/effect/api/api.ts#L1497-L1506) · [Session 域](./opencode/packages/plugin/src/effect/session.ts#L153-L170) · [Tool 域](./opencode/packages/plugin/src/effect/tool.ts#L54-L60) · [Host 映射](./opencode/packages/core/src/plugin/host.ts#L47-L75)
- `Transform<Editor>` 是 `(editor) => void`，返回 `Effect<Registration, never, Scope.Scope>`；editor 的变更在**未来状态重放时**执行，不在调用 `transform` 时读取一次便永久写入。`reload(): Effect<void>` 用于已捕获的外部数据变化后主动失效/重放；注册、显式 dispose 和作用域关闭也使状态失效。例子中 models.dev 先获取数据、同步闭包编辑 provider/integration，刷新流更新闭包里的快照后调用两个领域的 `reload`。[公共类型](./opencode/packages/plugin/src/effect/registration.ts#L27) · [State 接口](./opencode/packages/core/src/state.ts#L5-L30) · [注册与重载](./opencode/packages/core/src/state.ts#L220-L251) · [models.dev 实例](./opencode/packages/core/src/plugin/models-dev.ts#L26-L69)
- `Hooks<Spec, Failures>` 按 hook 名索引输入和类型化失败；callback 返回 `Effect<void, E>`，注册也需要 `Scope.Scope`。比如 `session.hook("context", ...)` 可修改将送给模型的 `system/messages/tools`，`tool.hook("execute.before", ...)` 可修改 `input`，`execute.after` 可修改结果/错误。只有 `execute.before` 的类型化错误允许 `Tool.Error`，其余这些运行时 hook 的失败类型是 `never`；这不排除缺陷（die）、中断或内部操作失败。`ModelHooks` 对含 `model` 的事件另有 `providerID` 过滤项。[Hook 签名](./opencode/packages/plugin/src/effect/registration.ts#L7-L25) · [Session 事件](./opencode/packages/plugin/src/effect/session.ts#L25-L36) · [Tool 事件/错误](./opencode/packages/plugin/src/effect/tool.ts#L20-L60) · [Core 的失败映射](./opencode/packages/core/src/plugin/hooks.ts#L21-L30)
- `Registration.dispose` 是 `Effect<void>`：注册存入按 `(domain, name)` 分组的列表，并向当前作用域加 finalizer；显式销毁是幂等的。触发时按注册先后**顺序** `yield*` 每个 callback，共享同一个可变 event，因此后注册者看见前者修改；`providerID` 不匹配则跳过。运行时 hook 不参与 `State` 的变换重放。[Hook 注册/执行](./opencode/packages/core/src/plugin/hooks.ts#L63-L104) · [状态注册/执行](./opencode/packages/core/src/state.ts#L172-L191)
- `ctx.event.subscribe` 复用生成的 Effect 客户端事件 API，直接提供 `Stream`；内置插件示例用 `Stream.runForEach(...).pipe(Effect.forkScoped)` 把持续监听绑定于插件作用域。插件也可用 `Effect.addFinalizer` 管理自己的资源，`ctx.storage` 经插件 ID 命名空间隔离 key。[Event 接口](./opencode/packages/plugin/src/effect/event.ts#L1-L3) · [流示例](./opencode/packages/core/src/plugin/models-dev.ts#L60-L69) · [插件存储](./opencode/packages/core/src/plugin/host.ts#L584-L610)

## 从发现到运行

1. 配置支持插件字符串或 `{ package, options? }`；配置根目录的 `plugin/`、`plugins/` 里会发现 `.ts/.js` 文件和目录。加载器解析本地路径或安装/解析 npm 包，优先找 `server`，再尝试包/目录默认入口；TUI、RPC 入口另行探测。模块默认导出必须满足 `{ id, effect }` 或 `{ id, setup }`；Promise 版被适配为 Effect，配置的 `options` 注入 Context。[配置 schema](./opencode/packages/schema/src/config/plugin.ts#L6-L14) · [目录发现](./opencode/packages/core/src/plugin/source-directory.ts#L7-L33) · [入口解析](./opencode/packages/plugin/src/host.ts#L17-L47) · [模块校验/适配](./opencode/packages/core/src/plugin/module.ts#L60-L73) · [实际加载](./opencode/packages/core/src/plugin/module.ts#L80-L132)
2. Supervisor 整理为 `内置 pre -> SDK/instance -> 外部包 -> 内置 post`，对来源变更进行监听/防抖并调用 registry 的 `activate`。每个定义带 `revision`；registry 保留相同 `(id, revision)` 的共同前缀，逆序关闭受影响后缀的旧作用域，再按顺序载入新后缀；`State.batch` 合并状态通知。同 ID、同 revision 的失败定义不会重复 setup，新的 revision 才会再尝试。[来源顺序](./opencode/packages/core/src/plugin/supervisor.ts#L91-L113) · [激活编排](./opencode/packages/core/src/plugin/supervisor.ts#L138-L175) · [监听](./opencode/packages/core/src/plugin/supervisor.ts#L196-L237) · [增量更替](./opencode/packages/core/src/plugin.ts#L89-L175)
3. 每个插件获得从 location 作用域 `Scope.fork` 出的子作用域；执行 `plugin.effect({...host, storage})` 时注入该作用域、日志配置、`State.group` 和批处理上下文。公共插件默认只要求 `Scope.Scope`；内部插件可在 setup 中额外要求内部服务，因为内置插件列表显式预先 `Effect.provide` 其依赖 Context。卸载/替换关闭子作用域，撤销注册与 scoped fibers/finalizers；整个 registry 关闭时进入不再通知的 shutdown 路径。[单插件加载](./opencode/packages/core/src/plugin.ts#L17-L86) · [内部插件环境](./opencode/packages/core/src/plugin/internal.ts#L154-L206) · [内部服务提供](./opencode/packages/core/src/plugin/internal.ts#L263-L276) · [关闭](./opencode/packages/core/src/plugin.ts#L238-L248)

## 状态重放与三类失败不要混淆

`State.create` 的注册表按 Set 顺序保存同步 transform。注册/销毁/`reload` 标脏并安排通知；下次读取或通知会从 `initial()` 的**新值**按顺序同步重放各项 editor 修改，成功后提交，旧读取值不会被原地修改。`State.batch` 合并通知，但批处理中读取仍会得到刷新值，**不是跨域事务或回滚机制**。例如 `Agent.Service` 将 `state.transform/reload` 直接接到领域能力，读取走 `state.get()`。[核心算法](./opencode/packages/core/src/state.ts#L160-L218) · [batch 语义](./opencode/packages/core/src/state.ts#L86-L110) · [Agent 使用](./opencode/packages/core/src/agent.ts#L65-L91) · [Agent 读取](./opencode/packages/core/src/agent.ts#L106-L130)

- **setup 失败：**尽管公共签名 `E = never`，插件仍可能 die/中断（且装载模块也可能失败）。registry 对 setup 执行 `Effect.exit`，失败时关闭该子作用域、记录日志和失败清单，不妨碍后续健康插件；替换版 setup 失败可尝试重启原版作回退。[接口](./opencode/packages/plugin/src/effect/plugin.ts#L56-L63) · [setup 的 Exit](./opencode/packages/core/src/plugin.ts#L64-L86) · [回退](./opencode/packages/core/src/plugin.ts#L139-L169) · [测试](./opencode/packages/core/test/plugin.test.ts#L137-L159)
- **同步 transform 重放失败：**`State.get()` 捕获其 throw，通过 setup 时注入的 `State.group` 同步摘除该插件的**全部 grouped transform**，丢弃本次候选并从干净 `initial()` 重放；插件 registry 再发布失败状态、刷新关联领域、异步关闭子作用域，因此不应暴露其部分编辑。测试涵盖初始激活以及稍后的 `reload` 触发。[组失效与重试](./opencode/packages/core/src/state.ts#L54-L75) · [重放](./opencode/packages/core/src/state.ts#L172-L194) · [失败工作队列](./opencode/packages/core/src/plugin.ts#L182-L235) · [初始化测试](./opencode/packages/core/test/plugin.test.ts#L161-L209) · [运行期重载测试](./opencode/packages/core/test/plugin.test.ts#L288-L346)
- **实时 hook 失败：**`PluginHooks.trigger` 直接逐个 `yield* callback(event)`，本身**没有** `State.group` 的摘除/自动禁用逻辑；类型允许的 `Tool.Error` 会让工具的 `execute.before` 拒绝运行，未处理的缺陷也沿调用路径传播，不能套用上段的 transform 失败恢复语义。[触发器](./opencode/packages/core/src/plugin/hooks.ts#L88-L95) · [类型化失败](./opencode/packages/core/src/plugin/hooks.ts#L21-L30) · [工具调用](./opencode/packages/core/src/tool.ts#L239-L244)

Promise 插件的 `setup(ctx)` 可返回异步 cleanup；适配器捕获 setup 时的 Effect Scope/上下文，把注册、hook callback、API 读取转换为 Promise、把事件 Stream 转成 AsyncIterable，最后以 `Effect.acquireRelease` 执行 Promise cleanup。因此它是**同一个 Effect 核心运行时的边界适配层**，而非两套并列的注册器；Promise 的 transform editor 回调也仍是同步的。[Promise Interface](./opencode/packages/plugin/src/promise/plugin.ts#L26-L65) · [适配器设计](./opencode/packages/plugin/src/promise/adapter.ts#L207-L249) · [同步 transform 包装](./opencode/packages/plugin/src/promise/adapter.ts#L279-L288) · [hook 适配](./opencode/packages/plugin/src/promise/adapter.ts#L575-L603)

**版本提醒：**`effect/PLAN.md` 写过 transform 回调返回 Effect、`rebuild()`、自动异步重建等目标，但当前 `Transform<Input>` 明确返回 `void`，现行方法叫 `reload()`，而 `State.get()` 在读取时同步重放。设计讨论时应以当下接口/实现为准，不把计划中的语义当成已上线能力。[计划片段](./opencode/packages/plugin/src/effect/PLAN.md#L48-L110) · [现行 Transform](./opencode/packages/plugin/src/effect/registration.ts#L27) · [现行 State](./opencode/packages/core/src/state.ts#L172-L218)
