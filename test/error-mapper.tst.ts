import type { Static } from "@sinclair/typebox";
import {
	type HttpException,
	type HttpStatus,
	httpException,
} from "awilixify/http";
import { expect, test } from "tstyche";
import { createErrorMapper, defineErrorMappings } from "../index.js";
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

const mappings = defineErrorMappings({
	"cats.not_found": [CatsError, () => httpException.notFound("No cats found")],
	"tenant.not_found": [
		TenantError,
		() => httpException.notFound("tenant.not_found"),
	],
	"auth.unauthorized": [
		AuthError,
		() => httpException.unauthorized("auth.unauthorized"),
	],
});

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

test("infers inline mapping tuples", () => {
	const inline = createErrorMapper({
		"cats.not_found": [CatsError, () => httpException.notFound("custom")],
	});

	expect(inline.toHttpError(new CatsError())).type.toBe<
		HttpException<"custom", HttpStatus.NOT_FOUND>
	>();
	expect(inline.toHttpError).type.not.toBeCallableWith(new TenantError());
	expect(createErrorMapper).type.toBeCallableWith({
		"plain.error": [Error, () => httpException.notFound()],
	});
	expect(createErrorMapper).type.not.toBeCallableWith({
		"cats.not_found": [CatsError, () => new Error()],
	});
});

test("reply accepts only errors declared in the route response schema", () => {
	const routeSchema = {
		response: schemaMapper.toResponseSchemas(["cats.not_found"]),
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
		"cats.not_found",
		"tenant.not_found",
		"auth.unauthorized",
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
		"unmapped",
	]);

	const selected = schemaMapper.toResponseSchemas(["cats.not_found"]);

	expect<keyof typeof selected>().type.toBe<HttpStatus.NOT_FOUND>();
	expect<Static<(typeof selected)[404]>>().type.toBe<{
		statusCode: HttpStatus.NOT_FOUND;
		message: "No cats found";
	}>();
});

test("module keys preserve exact mapped responses", () => {
	class MissingCat extends Error {
		readonly catId = "cat";
	}
	class MissingTenant extends Error {
		readonly tenantId = "tenant";
	}
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

	expect<keyof typeof cats>().type.toBe<"cats.missing">();
	expect(mapper.toHttpError(new MissingCat())).type.toBe<
		HttpException<"No cat", HttpStatus.NOT_FOUND>
	>();
	expect(mapper.toHttpError(new MissingTenant())).type.toBe<
		HttpException<"No tenant", HttpStatus.NOT_FOUND>
	>();
	expect(mapper.toHttpError).type.not.toBeCallableWith(new Error());
	const schemas = mapper.toResponseSchemas(["cats.missing"]);
	expect<Static<(typeof schemas)[404]>>().type.toBe<{
		statusCode: HttpStatus.NOT_FOUND;
		message: "No cat";
	}>();
	expect(mapper.toResponseSchemas).type.not.toBeCallableWith(["unknown"]);
	expect(defineErrorMappings).type.not.toBeCallableWith({
		invalid: [MissingCat, () => new Error()],
	});
});

test("defaults and literal exclusions preserve exact schema and Reply types", () => {
	const mapper = createTypeBoxErrorMapper(mappings, {
		defaultErrors: ["auth.unauthorized", "tenant.not_found"],
	});

	const defaults = mapper.toResponseSchemas();

	expect<keyof typeof defaults>().type.toBe<
		HttpStatus.NOT_FOUND | HttpStatus.UNAUTHORIZED
	>();

	const selected = mapper.toResponseSchemas(["cats.not_found"], {
		excludeDefaults: ["auth.unauthorized"],
	});

	expect<keyof typeof selected>().type.toBe<HttpStatus.NOT_FOUND>();
	expect<Static<(typeof selected)[404]>>().type.toBe<{
		statusCode: HttpStatus.NOT_FOUND;
		message: "No cats found" | "tenant.not_found";
	}>();

	const explicit = mapper.toResponseSchemas(["auth.unauthorized"], {
		excludeDefaults: ["auth.unauthorized", "tenant.not_found"],
	});

	expect<keyof typeof explicit>().type.toBe<HttpStatus.UNAUTHORIZED>();

	const empty = mapper.toResponseSchemas([], {
		excludeDefaults: ["auth.unauthorized", "tenant.not_found"],
	});
	expect<keyof typeof empty>().type.toBe<never>();

	expect(mapper.toResponseSchemas).type.not.toBeCallableWith([], {
		excludeDefaults: ["cats.not_found"],
	});
	expect(createTypeBoxErrorMapper).type.not.toBeCallableWith(mappings, {
		defaultErrors: ["unknown"],
	});

	const checkReply = (reply: Reply<{ response: typeof selected }>) => {
		expect(reply.code).type.not.toBeCallableWith(401);
		expect(reply.code(404).send).type.toBeCallableWith({
			statusCode: 404,
			message: "tenant.not_found",
		});
		expect(reply.code(404).send).type.not.toBeCallableWith({
			statusCode: 404,
			message: "other",
		});
	};
	void checkReply;
});
