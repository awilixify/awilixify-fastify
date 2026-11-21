import {
	type HttpException,
	schema as httpSchema,
	type RouteSchema,
} from "awilixify/http";
import type {
	ErrorKey,
	ErrorMapper,
	ErrorMappings,
	MappedException,
} from "../error-mapper.js";
import type {
	IsAny,
	MatchingReply,
	MatchingRequest,
	MatchingReturn,
	Reply,
	ReplyPayload,
	ReturnPayload,
	SchemaMismatch,
} from "./schema.js";

// -----------------------------------------------------------------------------
// Result return matching
// -----------------------------------------------------------------------------

// Match the same structural Result shapes recognized by isResultLike().
type ResultPayload<S extends RouteSchema, Returned> =
	Returned extends Reply<S>
		? never
		: Returned extends { ok: true; value: infer Value }
			? Value
			: Returned extends { ok: false; error: unknown }
				? never
				: Returned;

type ResultErrors<Returned> = Returned extends {
	ok: false;
	error: infer ErrorType;
}
	? ErrorType
	: never;

type ResponseForKey<
	S extends RouteSchema,
	Key extends PropertyKey,
> = S["response"][Extract<keyof S["response"], Key>];

type ResponseAtStatus<S extends RouteSchema, Status extends number> = [
	ResponseForKey<S, Status | `${Status}`>,
] extends [never]
	? `${Status}` extends `${infer First}${string}`
		? [ResponseForKey<S, `${First}xx`>] extends [never]
			? ResponseForKey<S, "default">
			: ResponseForKey<S, `${First}xx`>
		: never
	: ResponseForKey<S, Status | `${Status}`>;

type UndeclaredException<S extends RouteSchema, Exception> =
	Exception extends HttpException<string>
		? [ResponseAtStatus<S, Exception["statusCode"]>] extends [never]
			? Exception
			: ReturnType<Exception["getResponse"]> extends ReplyPayload<
						ResponseAtStatus<S, Exception["statusCode"]>
					>
				? never
				: Exception
		: never;

//  1. The error must be registered in the mapper.
//  2. Its mapped HTTP response must fit the route's response schema.
type MatchingResultErrors<
	S extends RouteSchema,
	Mappings extends ErrorMappings,
	Errors,
> =
	IsAny<Errors> extends true
		? SchemaMismatch<
				"Result error must not be any",
				InstanceType<Mappings[ErrorKey<Mappings>][0]>,
				Errors
			>
		: [Errors] extends [InstanceType<Mappings[ErrorKey<Mappings>][0]>]
			? MatchingMappedErrors<
					S,
					MappedException<Mappings[ErrorKey<Mappings>], Errors>
				>
			: SchemaMismatch<
					"Result errors must be registered in the error mapper",
					InstanceType<Mappings[ErrorKey<Mappings>][0]>,
					Errors
				>;

type MatchingMappedErrors<S extends RouteSchema, Exception> = [
	UndeclaredException<S, Exception>,
] extends [never]
	? unknown
	: SchemaMismatch<
			"Mapped Result errors must match declared response schemas",
			S["response"],
			UndeclaredException<S, Exception>
		>;

// -----------------------------------------------------------------------------
// Result-aware schema decorator
// -----------------------------------------------------------------------------

/** Type-check plain and Result returns. Result unwrapping still requires a custom request handler. */
export function createResultSchemaDecorator<
	const Mappings extends ErrorMappings,
>(_options: { errorMapper: ErrorMapper<Mappings> }) {
	return <const S extends RouteSchema>(routeSchema: S) => {
		const decorate = httpSchema(routeSchema);

		return <This, Method extends (...args: any[]) => unknown>(
			target: Method &
				MatchingRequest<S, Method> &
				MatchingReply<S, Method> &
				MatchingReturn<
					S,
					Method,
					ResultPayload<S, ReturnPayload<S, ReturnType<Method>>>
				> &
				MatchingResultErrors<
					S,
					Mappings,
					ResultErrors<ReturnPayload<S, ReturnType<Method>>>
				>,
			context: ClassMethodDecoratorContext<This, Method>,
		): Method => {
			decorate(target, context);

			return target;
		};
	};
}
