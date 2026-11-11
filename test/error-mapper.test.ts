import { httpException } from "awilixify/http";
import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { createErrorMapper } from "../index.js";
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

const mappings = [
	[CatsNotFoundError, () => httpException.notFound("No cats found")],
	[TenantNotFoundError, () => httpException.notFound("tenant.not_found")],
	[UnauthorizedError, () => httpException.unauthorized("auth.unauthorized")],
] as const;

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
			createErrorMapper([]).toHttpErrorFromUnknown(new Error()).statusCode,
		).toBe(500);
	});

	test("rejects duplicate constructor registrations", () => {
		expect(() => createErrorMapper([mappings[0], mappings[0]])).toThrow(
			"Duplicate error mapping: CatsNotFoundError",
		);
	});

	test("preserves extra response fields and propagates faulty factory failures", () => {
		const mapper = createErrorMapper([
			[
				CatsNotFoundError,
				() => httpException.notFound("missing", { detail: "public" }),
			],
			[
				UnknownError,
				() => {
					throw new Error("broken factory");
				},
			],
		]);

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
			CatsNotFoundError,
			TenantNotFoundError,
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
			CatsNotFoundError,
			CatsNotFoundError,
		]);

		expect(schemas[404].properties.message).toMatchObject({
			const: "No cats found",
			examples: ["No cats found"],
		});
		expect(schemas[404].properties.message.anyOf).toBeUndefined();
		// @ts-expect-error Unregistered constructors are rejected statically as well.
		expect(() => mapper.toResponseSchemas([UnknownError])).toThrow(
			"Unregistered error mapping",
		);
	});

	test("serializes mapped responses through Fastify", async () => {
		const app = Fastify();
		const mapper = createTypeBoxErrorMapper(mappings);

		app.get(
			"/cats",
			{ schema: { response: mapper.toResponseSchemas([CatsNotFoundError]) } },
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
