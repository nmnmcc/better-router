# Better Auth 的插件机制

研究基准：Better Auth 官方仓库 `fc45d08b26ac8e433fc7899a12be392cc52735ba`（2026-09-24）。以下描述的是该提交的实现，而非本项目的既有代码。

## 核心思路

它是**配置时显式装配的对象插件**：`betterAuth({ plugins: [myPlugin(options)] })` 接收插件实例数组；`BetterAuthPlugin` 仅强制要求 `id`，其余能力以可选属性声明，包括 `init`、`endpoints`、`schema`、`hooks`、`middlewares`、`onRequest`、`onResponse`、`rateLimit`、`adapter` 和 `$ERROR_CODES`。工厂函数是推荐的组织方式，不是加载器要求；`id` 用于识别插件，端点则按对象键及 HTTP 路径装配，并无动态发现或单独的容器。[官方文档](./better-auth/docs/content/docs/concepts/plugins.mdx#using-a-plugin) · [插件接口](./better-auth/packages/core/src/types/plugin.ts#L32-L163) · [配置类型](./better-auth/packages/core/src/types/init-options.ts#L939-L944)

```ts
import { createAuthEndpoint } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";

export const helloPlugin = () => ({
  id: "hello",
  endpoints: {
    sayHello: createAuthEndpoint("/hello/say-hello", { method: "GET" },
      async (ctx) => ctx.json({ message: "hello" })),
  },
}) satisfies BetterAuthPlugin;
// server: betterAuth({ plugins: [helloPlugin()] })
```

这个形式对应官方的 [自定义端点示例](./better-auth/docs/content/docs/concepts/plugins.mdx#endpoints)；`createAuthEndpoint` 基于 `better-call` 的 `createEndpoint` 加入 AuthContext 类型和处理包装。[源码](./better-auth/packages/core/src/api/index.ts#L64-L81) · [实现](./better-auth/packages/core/src/api/index.ts#L121-L166)

## 从注册到请求

1. `betterAuth` 调用 `createBetterAuth(options, init)`；初始化上下文时将用户插件与内部插件接合，**先**从 `schema` 汇总数据库表，**后**逐个执行 `plugin.init(ctx)`。`init` 可同步或异步返回 `context` 扩展及部分 `options`：上下文经 `Object.assign` 合并，普通配置用 `defu` 补入；数据库 hooks 和可信来源单独汇集，最终重建 `internalAdapter`。因此 schema 应在插件工厂返回的对象上声明，不能指望 `init` 的返回值补建已计算的表。[入口](./better-auth/packages/better-auth/src/auth/full.ts#L27-L31) · [装配顺序](./better-auth/packages/better-auth/src/context/create-context.ts#L189-L214) · [调用 init](./better-auth/packages/better-auth/src/context/create-context.ts#L428-L438) · [合并逻辑](./better-auth/packages/better-auth/src/context/helpers.ts#L23-L98)
2. `getEndpoints` 将插件的 `endpoints` 合并到基础端点对象中，用同一包装器产生 `auth.api`，再交给 `better-call` 的 `createRouter` 暴露 HTTP 路由；插件 `middlewares` 被展平后加入 router middleware。合并采用对象展开，键冲突会被后项覆盖；相同路径且 HTTP 方法冲突会被记录为错误日志，并非通过命名空间自动隔离。[端点与路由](./better-auth/packages/better-auth/src/api/index.ts#L173-L294) · [冲突检查](./better-auth/packages/better-auth/src/api/index.ts#L58-L171)
3. `toAuthEndpoints` 使 HTTP 请求和直接调用 `auth.api.*` 都经过 `dispatchAuthEndpoint`：先执行用户级 `before`，再按插件数组顺序执行匹配的 `before`，调用端点后依相同优先级执行 `after`。`before` 可改上下文或提前结束，`after` 可改结果；直接把某个原始 endpoint 当函数调用则跳过这套 hooks。[包装器](./better-auth/packages/better-auth/src/api/to-auth-endpoints.ts#L68-L116) · [排序与分发](./better-auth/packages/better-auth/src/api/dispatch.ts#L269-L318) · [执行过程](./better-auth/packages/better-auth/src/api/dispatch.ts#L359-L438)
4. `middlewares` 仅在 HTTP router 路径执行，`auth.api.*` 不经过它们；需要覆盖两种调用方式时用 `hooks`。`onRequest`/`onResponse` 是 router 的全局请求/响应阶段扩展；`onRequest` 可以替换请求或提前返回响应。插件的 `rateLimit` 规则也在 HTTP 请求进入路由时按 `pathMatcher` 选择。[文档说明](./better-auth/docs/content/docs/concepts/plugins.mdx#middleware) · [router 生命周期](./better-auth/packages/better-auth/src/api/index.ts#L274-L354) · [限流规则](./better-auth/packages/better-auth/src/api/rate-limiter/index.ts#L360-L379)

## Schema 与类型如何贯通

- `schema` 的表及字段按插件顺序合并；同名的 `user`/`session` 等核心表会扩展核心字段，其他表加入表集合。迁移/ORM schema 生成也读取这份结构，新增表或字段仍需生成并应用实际数据库变更。[表合并](./better-auth/packages/core/src/db/get-tables.ts#L29-L57) · [核心表](./better-auth/packages/core/src/db/get-tables.ts#L197-L245) · [CLI](./better-auth/docs/content/docs/concepts/cli.mdx#generate)
- 服务端 `Auth<Options>` 的 `api` 从配置中各插件的端点做联合转交叉/覆盖合并；`User`/`Session` 中的扩展字段由 `schema` 的 TS 字面量类型递归推导。`BetterAuthPluginRegistry` 的模块增强使 `ctx.getPlugin(id)` 拿到插件的精确类型，但**仅影响类型，不完成运行时注册**。[端点推导](./better-auth/packages/better-auth/src/api/index.ts#L173-L196) · [Auth 类型](./better-auth/packages/better-auth/src/types/auth.ts#L8-L30) · [字段推导](./better-auth/packages/core/src/db/type.ts#L120-L162) · [注册表](./better-auth/packages/core/src/types/context.ts#L57-L86) · [官方说明](./better-auth/docs/content/docs/concepts/plugins.mdx#register-a-plugin-type)
- 客户端单独调用 `createAuthClient({ plugins: [helloClient()] })`；`BetterAuthClientPlugin` 的 `$InferServerPlugin: {} as ReturnType<typeof helloPlugin>` 是**编译期桥梁**，从服务端端点路径、参数、返回值及 schema 推出客户端 API，不会把服务端代码带入客户端或替代服务端注册。客户端还可提供 `getActions`、`getAtoms`、`pathMethods`、`fetchPlugins`、`atomListeners`。[官方示例](./better-auth/docs/content/docs/concepts/plugins.mdx#creating-a-client-plugin) · [客户端接口](./better-auth/packages/core/src/types/plugin-client.ts#L94-L143) · [端点和字段推导](./better-auth/packages/better-auth/src/client/types.ts#L28-L51) · [字段类型](./better-auth/packages/better-auth/src/client/types.ts#L115-L134)
- 运行时客户端聚合插件 actions、atoms、方法与监听器，再使用 `Proxy` 将 `client.hello.sayHello()` 转成 `/hello/say-hello` 请求；没有显式方法时，有 body 默认为 POST，否则 GET，`pathMethods` 可覆盖。代理成功响应后按 `atomListeners` 发信号刷新订阅状态。[配置聚合](./better-auth/packages/better-auth/src/client/config.ts#L106-L197) · [代理实现](./better-auth/packages/better-auth/src/client/proxy.ts#L12-L124) · [类型映射](./better-auth/packages/better-auth/src/client/path-to-object.ts#L101-L113)

**实现时注意：**该提交的 `BetterAuthPlugin.rateLimit` 规则字段是 `max`（另有 `window` 和 `pathMatcher`），而当前概念文档的示例写 `limit`；按已安装版本的 TS 类型和源码使用 `max`。[接口](./better-auth/packages/core/src/types/plugin.ts#L145-L154) · [实际读取](./better-auth/packages/better-auth/src/api/rate-limiter/index.ts#L368-L377) · [文档示例](./better-auth/docs/content/docs/concepts/plugins.mdx#rate-limit)
