import { Redacted } from "effect"
import type { Layer, Result } from "effect"
import type { HttpClient } from "effect/http"
import { describe, expect, it } from "tstyche"
import type { DeploymentLimits, Pricing } from "@better-router/core/Deployment"
import type { ModelRouteConfig } from "@better-router/core/PluginContributions"
import type { CredentialResolver } from "@better-router/core/ProviderContract"
import * as Router from "@better-router/core/Router"
import * as Protocol from "@better-router/protocol-openai-chat-completions"
import * as Provider from "@better-router/provider-openai"
import {
	make,
	makePlugin,
	plugin,
	type ChatDeployment,
	type Options,
	type Plugin,
	type PluginConfig,
} from "@better-router/plugin-openai-chat-completions"

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
		? true
		: false

type WritableKeys<Value> = {
	[Key in keyof Value]-?: Equal<
		Pick<Value, Key>,
		{ -readonly [Property in Key]: Value[Property] }
	> extends true
		? Key
		: never
}[keyof Value]

const deployment = {
	id: "chat-primary",
	provider: "openai",
	model: "private-chat-model",
	protocol: "chat-completions",
	credentialRef: "openai-primary",
	baseUrl: "https://provider.example.test/v1/chat/completions",
	weight: 2,
	pricing: { inputPerToken: 0.000001, outputPerToken: 0.000002, currency: "USD" },
	limits: { maxConcurrent: 4, rpm: 20, tpm: 1000, maxTokens: 1024 },
	tags: ["primary"],
} as const satisfies ChatDeployment

const backup = { ...deployment, id: "chat-backup" } as const satisfies ChatDeployment

const routes = [
	{
		id: "chat-route",
		model: "public-model",
		deployments: [deployment.id],
		strategy: "least-busy",
		fallback: ["chat-backup"],
		retry: { maxAttempts: 2, retryableKinds: ["unavailable"] },
		access: { metadataKey: "tenant", allow: ["workspace"] },
		budget: { key: "workspace", limit: 10 },
	},
] as const satisfies readonly ModelRouteConfig[]

describe("OpenAI Chat Completions object plugin", () => {
	it("accepts complete readonly static declarations", () => {
		const configured = plugin({
			gatewayKey: Redacted.make("gateway-fixture"),
			deployments: [deployment, backup],
			routes,
		})

		expect(configured).type.toBe<Plugin>()
		expect(configured.config.deployments).type.toBe<readonly ChatDeployment[]>()
		expect(configured.config.deployments[0].provider).type.toBe<"openai">()
		expect(configured.config.deployments[0].protocol).type.toBe<"chat-completions">()
		expect(configured.config.deployments[0].credentialRef).type.toBe<string | undefined>()
		expect(configured.config.deployments[0].pricing).type.toBe<Pricing | undefined>()
		expect(configured.config.deployments[0].limits).type.toBe<DeploymentLimits | undefined>()
		expect(configured.config.deployments[0].tags).type.toBe<readonly string[] | undefined>()
		expect(configured.config.routes).type.toBe<readonly ModelRouteConfig[]>()
		expect(configured.config.routes[0].deployments).type.toBe<readonly string[]>()
		expect(configured.config.routes[0].fallback).type.toBe<readonly string[] | undefined>()

		expect<WritableKeys<Options>>().type.toBe<never>()
		expect<WritableKeys<Plugin>>().type.toBe<never>()
		expect<WritableKeys<PluginConfig>>().type.toBe<never>()
		expect<WritableKeys<ChatDeployment>>().type.toBe<never>()
		expect<WritableKeys<Pricing>>().type.toBe<never>()
		expect<WritableKeys<DeploymentLimits>>().type.toBe<never>()
		expect<WritableKeys<ModelRouteConfig>>().type.toBe<never>()
		expect<WritableKeys<NonNullable<ModelRouteConfig["retry"]>>>().type.toBe<never>()
		expect<WritableKeys<NonNullable<ModelRouteConfig["access"]>>>().type.toBe<never>()
		expect<WritableKeys<NonNullable<ModelRouteConfig["budget"]>>>().type.toBe<never>()
		expect<NonNullable<ModelRouteConfig["retry"]>["retryableKinds"]>().type.toBe<
			readonly string[] | undefined
		>()
		expect<NonNullable<ModelRouteConfig["access"]>["allow"]>().type.toBe<readonly string[]>()
		expect<Options["deployments"]>().type.toBe<readonly ChatDeployment[] | undefined>()
		expect<Options["routes"]>().type.toBe<readonly ModelRouteConfig[] | undefined>()
		expect(configured.config.deployments).type.not.toBeAssignableTo<ChatDeployment[]>()
		expect(configured.config.routes).type.not.toBeAssignableTo<ModelRouteConfig[]>()
	})

	it("keeps credential and HTTP client requirements visible at startup", () => {
		const declared = Router.make({
			plugins: [plugin({ deployments: [deployment, backup], routes })] as const,
		})
		type Declared = Result.Result.Success<typeof declared>
		type Bound = ReturnType<typeof Router.layer<Declared["plugins"]>>

		expect<Router.ServicesOf<Declared>>().type.toBe<
			HttpClient.HttpClient | CredentialResolver
		>()
		expect<Layer.Services<Bound>>().type.toBe<HttpClient.HttpClient | CredentialResolver>()
	})

	it("retains literal identity, capabilities, and the HTTP API", () => {
		const configured = plugin()
		type Http = PluginConfig["http"][0]

		expect(configured.id).type.toBe<"openai-chat-completions">()
		expect<Plugin["capabilities"]>().type.toBe<
			readonly [
				typeof Protocol.capability,
				typeof Provider.Deployment.chatCompletionsCapability,
			]
		>()
		expect(configured.capabilities[0].id).type.toBe<"protocol.openai.chat-completions">()
		expect(configured.capabilities[1].id).type.toBe<"provider.openai.chat-completions">()
		expect(configured.capabilities[0].kind).type.toBe<"protocol">()
		expect(configured.capabilities[1].kind).type.toBe<"provider">()
		expect(configured.capabilities[0].projections).type.toBe<readonly "generation"[]>()
		expect(configured.capabilities[1].projections).type.toBe<readonly "generation"[]>()
		expect(configured.config.providers).type.toBe<
			readonly [typeof Provider.Deployment.contract]
		>()
		expect(configured.config.projections).type.toBe<readonly [typeof Protocol.projection]>()
		expect<Http["api"]>().type.toBe<typeof Protocol.Api.api>()
		expect<Http["api"]["groups"]>().type.toHaveProperty("openAIChatCompletions")
		expect<Http["api"]["groups"]["openAIChatCompletions"]["endpoints"]>().type.toHaveProperty(
			"create",
		)
		expect(make).type.toBe<typeof plugin>()
		expect(makePlugin).type.toBe<typeof plugin>()
	})

	it("rejects legacy runtime configuration and incompatible deployments", () => {
		expect<keyof Options>().type.toBe<"gatewayKey" | "deployments" | "routes">()
		expect<Plugin>().type.not.toHaveProperty("state")
		expect<Plugin>().type.not.toHaveProperty("layers")
		expect<PluginConfig>().type.not.toHaveProperty("layers")
		expect<PluginConfig>().type.not.toHaveProperty("providersLayers")

		// @ts-expect-error! The removed provider option is not part of static plugin configuration.
		plugin({ provider: {} })
		// @ts-expect-error! Chat deployments cannot select the Responses protocol.
		plugin({ deployments: [{ ...deployment, protocol: "responses" }] })
		// @ts-expect-error! Chat deployments require the OpenAI provider.
		plugin({ deployments: [{ ...deployment, provider: "anthropic" }] })
	})
})
