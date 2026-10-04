import { Result, Schema } from "effect"
import { fromSchema } from "@better-router/core/Convert"
import type {
	GenerationEvent,
	GenerationRequest,
	GenerationResponse,
} from "@better-router/core/Generation"
import { Request as GenerationRequestSchema } from "@better-router/core/GenerationSchema"
import { ConversionError } from "@better-router/core/Convert"
import { Event, Request, Response } from "./Api.js"

export const decodeRequest = (value: unknown): Result.Result<GenerationRequest, ConversionError> =>
	Schema.decodeUnknownResult(Request)(value).pipe(
		Result.mapError((error) => fromSchema(error, "request")),
		Result.flatMap((decoded) =>
			Schema.decodeUnknownResult(GenerationRequestSchema)(decoded).pipe(
				Result.mapError((error) => fromSchema(error, "request")),
			),
		),
	)

export const encodeResponse = (
	value: GenerationResponse,
): Result.Result<GenerationResponse, ConversionError> =>
	Schema.encodeUnknownResult(Response)(value).pipe(
		Result.map(() => value),
		Result.mapError((error) => fromSchema(error, "response")),
	)

export const encodeEvent = (
	value: GenerationEvent,
): Result.Result<GenerationEvent, ConversionError> =>
	Schema.encodeUnknownResult(Event)(value).pipe(
		Result.map(() => value),
		Result.mapError((error) => fromSchema(error, "event")),
	)
