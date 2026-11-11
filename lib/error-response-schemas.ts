import {
	type TLiteral,
	type TObject,
	type TUnion,
	Type,
} from "@sinclair/typebox";
import type { HttpException } from "awilixify/http";
import {
	type ApplicationErrorConstructor,
	createErrorMapper as createHttpErrorMapper,
	type ErrorMapper,
	type ErrorMapping,
} from "./error-mapper.js";

type SelectedException<Mapping extends ErrorMapping, Selected> = ReturnType<
	Extract<Mapping, readonly [Selected, ErrorMapping[1]]>[1]
>;

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

type SelectedResponseSchemas<
	Mappings extends readonly ErrorMapping[],
	Selected extends readonly Mappings[number][0][],
> = ErrorResponseSchemas<SelectedException<Mappings[number], Selected[number]>>;

type TypeBoxErrorMapper<Mappings extends readonly ErrorMapping[]> =
	ErrorMapper<Mappings> & {
		toResponseSchemas<const Selected extends readonly Mappings[number][0][]>(
			errors: Selected,
		): SelectedResponseSchemas<Mappings, Selected>;
	};

/** Adds TypeBox response schemas without loading TypeBox through the root entry point. */
export function createErrorMapper<
	const Mappings extends readonly ErrorMapping[],
>(mappings: Mappings): TypeBoxErrorMapper<Mappings> {
	const mapper = createHttpErrorMapper(mappings);
	const factories = new Map<
		ApplicationErrorConstructor,
		() => HttpException<string>
	>(mappings);

	return {
		...mapper,
		toResponseSchemas<const Selected extends readonly Mappings[number][0][]>(
			errors: Selected,
		): SelectedResponseSchemas<Mappings, Selected> {
			const groups = new Map<number, Set<string>>();

			for (const errorClass of errors) {
				const factory = factories.get(errorClass);

				if (!factory)
					throw new Error(`Unregistered error mapping: ${errorClass.name}`);

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
							{
								examples: [...messages],
							},
						),
					}),
				]),
			) as SelectedResponseSchemas<Mappings, Selected>;
		},
	};
}
