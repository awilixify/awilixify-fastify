import {
	type TLiteral,
	type TObject,
	type TUnion,
	Type,
} from "@sinclair/typebox";
import type { HttpException } from "awilixify/http";
import {
	createErrorMapper as createHttpErrorMapper,
	type ErrorKey,
	type ErrorMapper,
	type ErrorMappings,
} from "./error-mapper.js";

type MessageAtStatus<Exception extends HttpException<string>, Status> = Extract<
	Exception,
	{ statusCode: Status }
>["message"];

export type ErrorResponseSchemas<Exception extends HttpException<string>> = {
	[Status in Exception["statusCode"]]: TObject<{
		statusCode: TLiteral<Status>;
		message: TUnion<TLiteral<MessageAtStatus<Exception, Status>>[]>;
	}>;
};

type SchemasForKeys<
	Mappings extends ErrorMappings,
	Keys extends ErrorKey<Mappings>,
> = ErrorResponseSchemas<ReturnType<Mappings[Keys][1]>>;

// Distribute conditional tuples. Widened arrays cannot guarantee any exclusion.
type SelectedResponseSchemas<
	Mappings extends ErrorMappings,
	Defaults extends readonly ErrorKey<Mappings>[],
	Selected extends readonly ErrorKey<Mappings>[],
	Excluded extends readonly Defaults[number][],
> = Excluded extends readonly Defaults[number][]
	? number extends Excluded["length"]
		?
				| SchemasForKeys<Mappings, Selected[number]>
				| SchemasForKeys<Mappings, Selected[number] | Defaults[number]>
		: SchemasForKeys<
				Mappings,
				Selected[number] | Exclude<Defaults[number], Excluded[number]>
			>
	: never;

type TypeBoxErrorMapper<
	Mappings extends ErrorMappings,
	Defaults extends readonly ErrorKey<Mappings>[],
> = ErrorMapper<Mappings> & {
	toResponseSchemas<
		const Selected extends readonly ErrorKey<Mappings>[] = readonly [],
		const Excluded extends readonly Defaults[number][] = readonly [],
	>(
		errors?: Selected,
		options?: { excludeDefaults?: Excluded },
	): SelectedResponseSchemas<Mappings, Defaults, Selected, Excluded>;
};

/** Adds TypeBox response schemas without loading TypeBox through the root entry point. */
export function createErrorMapper<
	const Mappings extends ErrorMappings,
	const Defaults extends readonly ErrorKey<Mappings>[] = readonly [],
>(
	mappings: Mappings,
	options: { defaultErrors?: Defaults } = {},
): TypeBoxErrorMapper<Mappings, Defaults> {
	const mapper = createHttpErrorMapper(mappings);
	const factories = new Map(
		Object.entries(mappings).map(([key, [, factory]]) => [key, factory]),
	);
	const defaults: readonly string[] = [...(options.defaultErrors ?? [])];

	for (const key of defaults) {
		if (!factories.has(key))
			throw new Error(`Unregistered error mapping: ${key}`);
	}

	const toResponseSchemas: TypeBoxErrorMapper<
		Mappings,
		Defaults
	>["toResponseSchemas"] = (errors, options) => {
		const excludeDefaults: readonly string[] = options?.excludeDefaults ?? [];

		for (const key of excludeDefaults) {
			if (!defaults.includes(key)) {
				throw new Error(`Not a default error mapping: ${key}`);
			}
		}

		const selected = new Set([
			...defaults.filter((key) => !excludeDefaults.includes(key)),
			...(errors ?? []),
		]);
		const groups = new Map<number, Set<string>>();

		for (const key of selected) {
			const factory = factories.get(key);

			if (!factory) throw new Error(`Unregistered error mapping: ${key}`);

			const { statusCode, message } = factory().getResponse();
			const messages = groups.get(statusCode) ?? new Set<string>();

			messages.add(message);
			groups.set(statusCode, messages);
		}

		return Object.fromEntries(
			[...groups].map(([status, messages]) => [
				status,
				Type.Object({
					statusCode: Type.Literal(status, { examples: [status] }),
					message: Type.Union(
						[...messages].map((message) => Type.Literal(message)),
						{ examples: [...messages] },
					),
				}),
			]),
		) as SelectedResponseSchemas<
			Mappings,
			Defaults,
			NonNullable<typeof errors>,
			NonNullable<NonNullable<typeof options>["excludeDefaults"]>
		>;
	};

	return {
		...mapper,
		toResponseSchemas,
	};
}
