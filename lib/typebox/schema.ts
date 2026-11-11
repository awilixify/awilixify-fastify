import type { Static, TSchema } from "@sinclair/typebox";
import { schema as httpSchema, type RouteSchema } from "awilixify/http";
import type {
	ContextConfigDefault,
	FastifyReply,
	FastifyRequest,
	FastifyTypeProvider,
	RawReplyDefaultExpression,
	RawRequestDefaultExpression,
	RawServerDefault,
	RouteGenericInterface,
} from "fastify";

// -----------------------------------------------------------------------------
// Request types
// -----------------------------------------------------------------------------

export type Request<S extends RouteSchema> = FastifyRequest<{
	Querystring: S["querystring"] extends TSchema
		? Static<S["querystring"]>
		: unknown;
	Params: S["params"] extends TSchema ? Static<S["params"]> : unknown;
	Body: S["body"] extends TSchema ? Static<S["body"]> : unknown;
	Headers: S["headers"] extends TSchema ? Static<S["headers"]> : unknown;
}>;

// -----------------------------------------------------------------------------
// Reply types
// -----------------------------------------------------------------------------

// A status entry can contain a schema directly:
// response: { 200: Type.Object({ name: Type.String() }) } -> { name: string }
// Or different schemas per content type:
// response: { 200: { content: {
//   "application/json": { schema: Type.Object({ name: Type.String() }) },
//   "text/plain": { schema: Type.String() },
// } } } -> { name: string } | string
// Extract that payload type (or union) for reply.send() and return checks.
// This does not select a content type or narrow payloads based on reply.type().
export type ReplyPayload<Schema> = Schema extends TSchema
	? Static<Schema>
	: Schema extends {
				content: Record<string, { schema: infer Payload extends TSchema }>;
			}
		? Static<Payload>
		: unknown;

// Adapt Static to Fastify's reply inference without an external provider dependency.
interface TypeBoxReplyProvider extends FastifyTypeProvider {
	serializer: ReplyPayload<this["schema"]>;
}

export type Reply<S extends RouteSchema> = keyof S["response"] extends never
	? FastifyReply
	: FastifyReply<
			RouteGenericInterface,
			RawServerDefault,
			RawRequestDefaultExpression,
			RawReplyDefaultExpression,
			ContextConfigDefault,
			S,
			TypeBoxReplyProvider
		>;

// -----------------------------------------------------------------------------
// Shared type checks and diagnostics
// -----------------------------------------------------------------------------

export type IsAny<T> = 0 extends 1 & T ? true : false;

type AreTypesEqual<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;

export type SchemaMismatch<Message extends string, Expected, Actual> = {
	readonly __schemaError: Message;
	readonly expected: Expected;
	readonly actual: Actual;
};

// -----------------------------------------------------------------------------
// Request parameter matching
// -----------------------------------------------------------------------------

export type MatchingRequest<
	S extends RouteSchema,
	Method extends (...args: any[]) => unknown,
> =
	Parameters<Method> extends []
		? unknown // No parameters: nothing to check.
		: IsAny<Parameters<Method>[0]> extends true
			? SchemaMismatch<
					"Request parameter must not be any",
					Request<S>,
					Parameters<Method>[0]
				> // Reject any, which would bypass matching.
			: [Parameters<Method>[0], Request<S>] extends [
						Request<S>,
						Parameters<Method>[0],
					]
				? unknown // Both directions match: accept.
				: SchemaMismatch<
						"Request parameter must match the route schema",
						Request<S>,
						Parameters<Method>[0]
					>; // The parameter is broader, narrower, or incompatible.

// -----------------------------------------------------------------------------
// Reply parameter matching
// -----------------------------------------------------------------------------

export type MatchingReply<
	S extends RouteSchema,
	Method extends (...args: any[]) => unknown,
> = "1" extends keyof Parameters<Method> // Check whether a second parameter exists.
	? IsAny<Parameters<Method>[1]> extends true
		? SchemaMismatch<
				"Reply parameter must not be any",
				Reply<S>,
				Parameters<Method>[1]
			> // Reject any, which would bypass matching.
		: AreTypesEqual<Parameters<Method>[1], Reply<S>> extends true
			? unknown // The reply types match: accept.
			: SchemaMismatch<
					"Reply parameter must match the route schema",
					Reply<S>,
					Parameters<Method>[1]
				> // The declared reply differs from the schema-derived reply.
	: unknown; // No reply parameter: nothing to check.

// -----------------------------------------------------------------------------
// Return type matching
// -----------------------------------------------------------------------------

// Select response 200, accepting numeric and string status keys.
type SuccessSchema<S extends RouteSchema> = S["response"][Extract<
	keyof S["response"],
	200 | "200"
>];

// Exclude manually returned replies; unwrap promises for plain payloads.
export type ReturnPayload<S extends RouteSchema, Result> =
	Result extends Reply<S> ? never : Awaited<Result>;

export type MatchingReturn<
	S extends RouteSchema,
	Method extends (...args: any[]) => unknown,
	Payload = ReturnPayload<S, ReturnType<Method>>,
> = [SuccessSchema<S>, unknown] extends
	| [never, unknown]
	| [unknown, ReplyPayload<SuccessSchema<S>>]
	? unknown // No response 200, or its payload is unconstrained/uninferable.
	: true extends IsAny<Awaited<ReturnType<Method>>> | IsAny<Payload>
		? SchemaMismatch<
				"Return type must not be any",
				ReplyPayload<SuccessSchema<S>>,
				Awaited<ReturnType<Method>>
			> // Reject any, which would bypass payload checking.
		: [Payload] extends [ReplyPayload<SuccessSchema<S>>]
			? unknown // The payload matches, or the method returns a typed reply.
			: SchemaMismatch<
					"Return payload must match response[200]",
					ReplyPayload<SuccessSchema<S>>,
					Payload
				>; // The returned payload does not match response 200.

// -----------------------------------------------------------------------------
// Schema decorator
// -----------------------------------------------------------------------------

/** Check declared request/reply types and plain returns against response[200]. */
export function schema<const S extends RouteSchema>(routeSchema: S) {
	const decorate = httpSchema(routeSchema);

	return <This, Method extends (...args: any[]) => unknown>(
		target: Method &
			MatchingRequest<S, Method> &
			MatchingReply<S, Method> &
			MatchingReturn<S, Method>,
		context: ClassMethodDecoratorContext<This, Method>,
	): Method => {
		decorate(target, context);

		return target;
	};
}
