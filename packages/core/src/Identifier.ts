/** A declaration identifier retains a literal when the caller supplies one. */
export type Identifier<Value extends string = string> = Value

export type IdOf<Value> = Value extends { readonly id: infer Id extends string } ? Id : never

export type ItemsOf<Value, Key extends PropertyKey> = Value extends {
	readonly [Property in Key]?: infer Items
}
	? NonNullable<Items> extends readonly (infer Item)[]
		? Item
		: never
	: never

export type ItemIdsOf<Value, Key extends PropertyKey> = IdOf<ItemsOf<Value, Key>>

/** Widened strings represent values supplied at runtime and cannot be checked by spelling. */
export type PreserveLiteral<Value extends string> = string extends Value ? string : Value
