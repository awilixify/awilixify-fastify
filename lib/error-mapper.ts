import { type HttpException, httpException } from "awilixify/http";

export type ApplicationErrorConstructor = abstract new (
	...args: any[]
) => Error;

export type ErrorMapping = readonly [
	ApplicationErrorConstructor,
	() => HttpException<string>,
];

export type ErrorMappings = Readonly<Record<string, ErrorMapping>>;
export type ErrorKey<Mappings extends ErrorMappings> = Extract<
	keyof Mappings,
	string
>;

export type MappedException<Mapping, ErrorType> = Mapping extends ErrorMapping
	? ErrorType extends InstanceType<Mapping[0]>
		? ReturnType<Mapping[1]>
		: never
	: never;

const MODULE_METADATA = Symbol("error mapping metadata");
type ModuleMetadata = {
	readonly [MODULE_METADATA]: true;
	readonly entries: readonly (readonly [string, ErrorMapping])[];
};

function validateModuleMappings(mappings: ErrorMappings): void {
	const keys = new Set<string>();

	// Each module uses a unique symbol so spreads retain all collision metadata instead of overwriting it.
	for (const symbol of Object.getOwnPropertySymbols(mappings)) {
		const metadata = Reflect.get(mappings, symbol) as
			| ModuleMetadata
			| undefined;

		if (metadata?.[MODULE_METADATA] !== true) continue;

		for (const [key, mapping] of metadata.entries) {
			if (keys.has(key) || mappings[key] !== mapping) {
				throw new Error(`Duplicate error mapping key: ${key}`);
			}

			keys.add(key);
		}
	}
}

declare const ERROR_MAPPINGS: unique symbol;

export interface ErrorMapper<Mappings extends ErrorMappings> {
	// Retain the mapping types for schema-decorator inference without runtime metadata.
	readonly [ERROR_MAPPINGS]?: Mappings;
	toHttpError<ErrorType extends InstanceType<Mappings[ErrorKey<Mappings>][0]>>(
		error: ErrorType,
	): MappedException<Mappings[ErrorKey<Mappings>], ErrorType>;
	toHttpErrorFromUnknown(
		error: unknown,
	):
		| ReturnType<Mappings[ErrorKey<Mappings>][1]>
		| ReturnType<typeof httpException.internalServerError>;
}

/** Preserve literal types and attach collision metadata that survives object spreads. */
export function defineErrorMappings<const Mappings extends ErrorMappings>(
	mappings: Mappings,
): Mappings {
	validateModuleMappings(mappings);

	return {
		...Object.fromEntries(Object.entries(mappings)),
		[Symbol("error mappings")]: {
			[MODULE_METADATA]: true,
			entries: Object.entries(mappings),
		} satisfies ModuleMetadata,
	} as Mappings;
}

/** Match exact constructors. Factories must be side-effect-free and return fixed responses. */
export function createErrorMapper<const Mappings extends ErrorMappings>(
	mappings: Mappings,
): ErrorMapper<Mappings> {
	validateModuleMappings(mappings);

	const factories = new Map<
		ApplicationErrorConstructor,
		() => HttpException<string>
	>();

	for (const [errorClass, factory] of Object.values(mappings)) {
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
