import { httpException } from "awilixify/http";
import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { createErrorMapper, defineErrorMappings } from "../index.js";
import { createErrorMapper as createTypeBoxErrorMapper } from "../lib/typebox/index.js";

class CatsNotFoundError extends Error {
	readonly code = "cats.not_found";
}
class TenantNotFoundError extends Error {
	readonly code = "tenant.not_found";
}
class UnauthorizedError extends Error {
	readonly code = "auth.unauthorized";
}
class UnknownError extends Error {
	readonly code = "unknown";
}

const mappings = defineErrorMappings({
	"cats.not_found": [
		CatsNotFoundError,
		() => httpException.notFound("No cats found"),
	],
	"tenant.not_found": [
		TenantNotFoundError,
		() => httpException.notFound("tenant.not_found"),
	],
	"auth.unauthorized": [
		UnauthorizedError,
		() => httpException.unauthorized("auth.unauthorized"),
	],
});

describe("error mapper", () => {
	test("maps exact constructors and preserves the factory response", () => {
		const mapper = createErrorMapper(mappings);

		expect(mapper.toHttpError(new CatsNotFoundError()).getResponse()).toEqual({
			statusCode: 404,
			message: "No cats found",
		});
		expect(
			mapper.toHttpErrorFromUnknown(new UnauthorizedError()).statusCode,
		).toBe(401);
	});

	test("returns a generic 500 for unknown values and unregistered subclasses", () => {
		class SpecialCatsError extends CatsNotFoundError {}
		const mapper = createErrorMapper(mappings);
		for (const error of [
			new UnknownError("secret"),
			new SpecialCatsError(),
			null,
			undefined,
			"secret",
			{ code: "cats.not_found" },
		]) {
			expect(mapper.toHttpErrorFromUnknown(error).getResponse()).toEqual({
				statusCode: 500,
				message: "Internal Server Error",
			});
		}
		// Subclasses are assignable in TypeScript, but dispatch remains exact at runtime.
		expect(mapper.toHttpError(new SpecialCatsError()).statusCode).toBe(500);
		expect(
			createErrorMapper({}).toHttpErrorFromUnknown(new Error()).statusCode,
		).toBe(500);
	});

	test("rejects duplicate constructor registrations", () => {
		expect(() =>
			createErrorMapper({
				"duplicate.0": mappings["cats.not_found"],
				"duplicate.1": mappings["cats.not_found"],
			}),
		).toThrow("Duplicate error mapping: CatsNotFoundError");
	});

	test("preserves extra response fields and propagates faulty factory failures", () => {
		const mapper = createErrorMapper({
			"cats.not_found": [
				CatsNotFoundError,
				() => httpException.notFound("missing", { detail: "public" }),
			],
			unknown: [
				UnknownError,
				() => {
					throw new Error("broken factory");
				},
			],
		});

		expect(mapper.toHttpError(new CatsNotFoundError()).getResponse()).toEqual({
			statusCode: 404,
			message: "missing",
			detail: "public",
		});
		expect(() => mapper.toHttpErrorFromUnknown(new UnknownError())).toThrow(
			"broken factory",
		);
	});
});

describe("error response schemas", () => {
	test("groups selected errors by status with response examples", () => {
		const mapper = createTypeBoxErrorMapper(mappings);

		const schemas = mapper.toResponseSchemas([
			"cats.not_found",
			"tenant.not_found",
		]);

		expect(Object.keys(schemas)).toEqual(["404"]);

		expect(schemas[404].properties.statusCode).toMatchObject({
			type: "number",
			const: 404,
			examples: [404],
		});
		const messageSchema = schemas[404].properties.message;
		expect(messageSchema.anyOf).toMatchObject([
			{ type: "string", const: "No cats found" },
			{ type: "string", const: "tenant.not_found" },
		]);
		expect(messageSchema.examples).toEqual([
			"No cats found",
			"tenant.not_found",
		]);
		expect(mapper.toResponseSchemas([])).toEqual({});
	});

	test("deduplicates messages and rejects unregistered selections at runtime", () => {
		const mapper = createTypeBoxErrorMapper(mappings);
		const schemas = mapper.toResponseSchemas([
			"cats.not_found",
			"cats.not_found",
		]);

		expect(schemas[404].properties.message).toMatchObject({
			const: "No cats found",
			examples: ["No cats found"],
		});
		expect(schemas[404].properties.message.anyOf).toBeUndefined();
		// @ts-expect-error Unregistered constructors are rejected statically as well.
		expect(() => mapper.toResponseSchemas(["unknown"])).toThrow(
			"Unregistered error mapping",
		);
	});

	test("serializes mapped responses through Fastify", async () => {
		const app = Fastify();
		const mapper = createTypeBoxErrorMapper(mappings);

		app.get(
			"/cats",
			{ schema: { response: mapper.toResponseSchemas(["cats.not_found"]) } },
			(_request, reply) => {
				const error = mapper.toHttpError(new CatsNotFoundError());

				return reply.status(error.statusCode).send(error.getResponse());
			},
		);

		try {
			const response = await app.inject("/cats");
			expect(response.statusCode).toBe(404);
			expect(response.json()).toEqual({
				statusCode: 404,
				message: "No cats found",
			});
		} finally {
			await app.close();
		}
	});
});

describe("module mappings", () => {
	test("maps errors from composed module maps", () => {
		class MissingCat extends Error {}
		class MissingTenant extends Error {}
		const cats = defineErrorMappings({
			"cats.missing": [MissingCat, () => httpException.notFound("No cat")],
		});
		const tenants = defineErrorMappings({
			"tenants.missing": [
				MissingTenant,
				() => httpException.notFound("No tenant"),
			],
		});

		const mapper = createTypeBoxErrorMapper({ ...cats, ...tenants });

		expect(mapper.toHttpError(new MissingCat()).message).toBe("No cat");
		expect(mapper.toHttpError(new MissingTenant()).message).toBe("No tenant");
		expect(Object.keys(mapper.toResponseSchemas(["cats.missing"]))).toEqual([
			"404",
		]);
	});

	test("rejects duplicate keys even after spread has overwritten them", () => {
		const cats = defineErrorMappings({ duplicate: mappings["cats.not_found"] });
		const tenants = defineErrorMappings({
			duplicate: mappings["tenant.not_found"],
		});

		expect(() => createErrorMapper({ ...cats, ...tenants })).toThrow(
			"Duplicate error mapping key: duplicate",
		);
		expect(() => createErrorMapper({ ...tenants, ...cats })).toThrow(
			"Duplicate error mapping key: duplicate",
		);
		expect(() =>
			createErrorMapper({ ...cats, duplicate: mappings["tenant.not_found"] }),
		).toThrow("Duplicate error mapping key: duplicate");
		expect(() => createTypeBoxErrorMapper({ ...cats, ...tenants })).toThrow(
			"Duplicate error mapping key: duplicate",
		);
	});
});

describe("default response errors", () => {
	const mapper = createTypeBoxErrorMapper(mappings, {
		defaultErrors: ["auth.unauthorized", "tenant.not_found"],
	});

	test("includes defaults with no selection and merges messages sharing a status", () => {
		expect(Object.keys(mapper.toResponseSchemas())).toEqual(["401", "404"]);
		const schemas = mapper.toResponseSchemas(["cats.not_found"]);
		expect(schemas[404].properties.message.examples).toEqual([
			"tenant.not_found",
			"No cats found",
		]);
		expect(schemas[401].properties.message.examples).toEqual([
			"auth.unauthorized",
		]);
	});

	test("excludes defaults without removing explicitly selected errors", () => {
		expect(
			Object.keys(
				mapper.toResponseSchemas([], {
					excludeDefaults: ["auth.unauthorized"],
				}),
			),
		).toEqual(["404"]);
		expect(
			mapper.toResponseSchemas([], {
				excludeDefaults: ["auth.unauthorized", "tenant.not_found"],
			}),
		).toEqual({});
		expect(
			Object.keys(
				mapper.toResponseSchemas(["auth.unauthorized"], {
					excludeDefaults: ["auth.unauthorized", "tenant.not_found"],
				}),
			),
		).toEqual(["401"]);
	});

	test("validates runtime defaults and exclusions", () => {
		expect(() =>
			// @ts-expect-error Unknown default key.
			createTypeBoxErrorMapper(mappings, { defaultErrors: ["unknown"] }),
		).toThrow("Unregistered error mapping: unknown");
		expect(() =>
			// @ts-expect-error Registered, but not a configured default.
			mapper.toResponseSchemas([], { excludeDefaults: ["cats.not_found"] }),
		).toThrow("Not a default error mapping: cats.not_found");
	});
});
