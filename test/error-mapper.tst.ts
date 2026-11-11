import type { Static } from "@sinclair/typebox";
import {
	type HttpException,
	type HttpStatus,
	httpException,
} from "awilixify/http";
import { expect, test } from "tstyche";
import { createErrorMapper } from "../index.js";
import {
	createErrorMapper as createTypeBoxErrorMapper,
	type Reply,
} from "../lib/typebox/index.js";

class CatsError extends Error {
	readonly code = "cats.not_found";
}
class TenantError extends Error {
	readonly code = "tenant.not_found";
}
class AuthError extends Error {
	readonly code = "auth.unauthorized";
}
class UnmappedError extends Error {
	readonly code = "unmapped";
}

const mappings = [
	[CatsError, () => httpException.notFound("No cats found")],
	[TenantError, () => httpException.notFound("tenant.not_found")],
	[AuthError, () => httpException.unauthorized("auth.unauthorized")],
] as const;

const mapper = createErrorMapper(mappings);
const schemaMapper = createTypeBoxErrorMapper(mappings);

declare const result:
	| { ok: true; value: string[] }
	| { ok: false; error: CatsError | UnmappedError };

test("rejects unsupported controller errors and preserves exception types", () => {
	expect(mapper.toHttpError).type.toBeCallableWith(new CatsError());
	expect(mapper.toHttpError).type.not.toBeCallableWith(new UnmappedError());
	expect(mapper.toHttpError).type.not.toBeCallableWith(new Error());
	expect(mapper.toHttpError).type.not.toBeCallableWith(null);

	if (!result.ok) {
		expect(mapper.toHttpError).type.not.toBeCallableWith(result.error);
	}

	expect(mapper.toHttpError(new CatsError())).type.toBe<
		HttpException<"No cats found", HttpStatus.NOT_FOUND>
	>();
	expect(mapper.toHttpErrorFromUnknown).type.toBeCallableWith(null);
	expect(mapper.toHttpErrorFromUnknown).type.toBeCallableWith(
		new UnmappedError(),
	);
});

test("infers inline tuples without requiring static codes or a shared base class", () => {
	const inline = createErrorMapper([
		[CatsError, () => httpException.notFound("custom")],
	]);

	expect(inline.toHttpError(new CatsError())).type.toBe<
		HttpException<"custom", HttpStatus.NOT_FOUND>
	>();
	expect(inline.toHttpError).type.not.toBeCallableWith(new TenantError());
	expect(createErrorMapper).type.not.toBeCallableWith([
		[Error, () => httpException.notFound()],
	]);
	expect(createErrorMapper).type.not.toBeCallableWith([
		[CatsError, () => new Error()],
	]);
});

test("reply accepts only errors declared in the route response schema", () => {
	const routeSchema = {
		response: schemaMapper.toResponseSchemas([CatsError]),
	};
	const declaredError = schemaMapper.toHttpError(new CatsError());
	const omittedError = schemaMapper.toHttpError(new TenantError());
	const otherStatusError = schemaMapper.toHttpError(new AuthError());

	const checkReply = (
		reply: Reply<typeof routeSchema>,
		error: CatsError | TenantError,
	) => {
		expect(reply.code(declaredError.statusCode).send).type.toBeCallableWith(
			declaredError.getResponse(),
		);
		expect(reply.code).type.toBeCallableWith(declaredError.statusCode);

		expect(reply.code(omittedError.statusCode).send).type.not.toBeCallableWith(
			omittedError.getResponse(),
		);
		expect(reply.code).type.not.toBeCallableWith(otherStatusError.statusCode);

		const mapped = schemaMapper.toHttpError(error);

		expect(reply.code(mapped.statusCode).send).type.not.toBeCallableWith(
			mapped.getResponse(),
		);
	};

	void checkReply;
});

test("schemas preserve selected statuses and message unions", () => {
	const schemas = schemaMapper.toResponseSchemas([
		CatsError,
		TenantError,
		AuthError,
	]);

	expect<keyof typeof schemas>().type.toBe<
		HttpStatus.NOT_FOUND | HttpStatus.UNAUTHORIZED
	>();
	expect<Static<(typeof schemas)[404]>>().type.toBe<{
		statusCode: HttpStatus.NOT_FOUND;
		message: "No cats found" | "tenant.not_found";
	}>();
	expect<Static<(typeof schemas)[401]>>().type.toBe<{
		statusCode: HttpStatus.UNAUTHORIZED;
		message: "auth.unauthorized";
	}>();
	expect(schemaMapper.toResponseSchemas).type.not.toBeCallableWith([
		UnmappedError,
	]);

	const selected = schemaMapper.toResponseSchemas([CatsError]);

	expect<keyof typeof selected>().type.toBe<HttpStatus.NOT_FOUND>();
	expect<Static<(typeof selected)[404]>>().type.toBe<{
		statusCode: HttpStatus.NOT_FOUND;
		message: "No cats found";
	}>();
});
