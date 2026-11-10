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

export type Request<S extends RouteSchema> = FastifyRequest<{
	Querystring: S["querystring"] extends TSchema
		? Static<S["querystring"]>
		: unknown;
	Params: S["params"] extends TSchema ? Static<S["params"]> : unknown;
	Body: S["body"] extends TSchema ? Static<S["body"]> : unknown;
	Headers: S["headers"] extends TSchema ? Static<S["headers"]> : unknown;
}>;

type ReplyPayload<Schema> = Schema extends TSchema
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

type MatchingRequest<
	S extends RouteSchema,
	Method extends (...args: any[]) => unknown,
> =
	Parameters<Method> extends []
		? unknown
		: 0 extends 1 & Parameters<Method>[0]
			? never
			: [Parameters<Method>[0]] extends [Request<S>]
				? [Request<S>] extends [Parameters<Method>[0]]
					? unknown
					: never
				: never;

type MatchingReply<
	S extends RouteSchema,
	Method extends (...args: any[]) => unknown,
> = "1" extends keyof Parameters<Method>
	? 0 extends 1 & Parameters<Method>[1]
		? never
		: (<T>() => T extends Parameters<Method>[1] ? 1 : 2) extends <
					T,
				>() => T extends Reply<S> ? 1 : 2
			? unknown
			: never
	: unknown;

/** Register an HTTP schema and require matching request/reply types when declared. */
export function schema<const S extends RouteSchema>(routeSchema: S) {
	const decorate = httpSchema(routeSchema);

	return <This, Method extends (...args: any[]) => unknown>(
		target: Method & MatchingRequest<S, Method> & MatchingReply<S, Method>,
		context: ClassMethodDecoratorContext<This, Method>,
	): Method => {
		decorate(target, context);
		return target;
	};
}
