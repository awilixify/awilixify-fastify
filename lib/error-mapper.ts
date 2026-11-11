import { type HttpException, httpException } from "awilixify/http";

export type ApplicationError = Error & { readonly code: string };

export type ApplicationErrorConstructor = abstract new (
	...args: any[]
) => ApplicationError;

export type ErrorMapping = readonly [
	ApplicationErrorConstructor,
	() => HttpException<string>,
];

export type MappedException<Mapping, ErrorType> = Mapping extends ErrorMapping
	? ErrorType extends InstanceType<Mapping[0]>
		? ReturnType<Mapping[1]>
		: never
	: never;

declare const ERROR_MAPPINGS: unique symbol;

export interface ErrorMapper<Mappings extends readonly ErrorMapping[]> {
	// Retain the tuple types for schema-decorator inference without runtime metadata.
	readonly [ERROR_MAPPINGS]?: Mappings;
	toHttpError<ErrorType extends InstanceType<Mappings[number][0]>>(
		error: ErrorType,
	): MappedException<Mappings[number], ErrorType>;
	toHttpErrorFromUnknown(
		error: unknown,
	):
		| ReturnType<Mappings[number][1]>
		| ReturnType<typeof httpException.internalServerError>;
}

/** Match exact constructors. Factories must be side-effect-free and return fixed responses. */
export function createErrorMapper<
	const Mappings extends readonly ErrorMapping[],
>(mappings: Mappings): ErrorMapper<Mappings> {
	const factories = new Map<
		ApplicationErrorConstructor,
		() => HttpException<string>
	>();

	for (const [errorClass, factory] of mappings) {
		if (factories.has(errorClass)) {
			throw new Error(`Duplicate error mapping: ${errorClass.name}`);
		}

		factories.set(errorClass, factory);
	}

	const toHttpErrorFromUnknown = (error: unknown) => {
		const factory =
			error instanceof Error
				? factories.get(error.constructor as ApplicationErrorConstructor)
				: undefined;

		return factory ? factory() : httpException.internalServerError();
	};

	return {
		// The fallback also protects typed callers from unexpected runtime values.
		toHttpError: toHttpErrorFromUnknown as ErrorMapper<Mappings>["toHttpError"],
		toHttpErrorFromUnknown:
			toHttpErrorFromUnknown as ErrorMapper<Mappings>["toHttpErrorFromUnknown"],
	};
}
