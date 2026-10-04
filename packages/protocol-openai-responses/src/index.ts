import { Layer } from "effect"
import { Route } from "@better-router/core/Route"
import type { Contract } from "@better-router/core/Api"
import * as ApiModule from "./Api.js"
import * as HttpModule from "./Http.js"

export * as Api from "./Api.js"
export * as Convert from "./Convert.js"
export * as Http from "./Http.js"
export * as OpenAIResponsesSchema from "./OpenAIResponsesSchema.js"
export * as OpenResponses from "./OpenResponses.js"

export const makeContract = (options: HttpModule.Options = {}): Contract<typeof ApiModule.api> => ({
	api: ApiModule.api,
	layer: (route) =>
		HttpModule.layer(options).pipe(Layer.provide(Layer.succeed(Route, route))) as never,
})

export const contract = makeContract()
