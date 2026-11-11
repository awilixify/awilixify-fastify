import { Type } from "@sinclair/typebox";
import { Result } from "awilixify";
import { httpException } from "awilixify/http";
import { expect, test } from "tstyche";
import {
	createErrorMapper,
	createResultSchemaDecorator,
	type Reply,
	type Request,
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
const errorMapper = createErrorMapper([
	[CatsError, () => httpException.notFound("cats.not_found")],
	[TenantError, () => httpException.notFound("tenant.not_found")],
	[AuthError, () => httpException.unauthorized("auth.unauthorized")],
]);
const resultSchema = createResultSchemaDecorator({ errorMapper });
const routeSchema = {
	params: Type.Object({ id: Type.String() }),
	response: {
		200: Type.Array(Type.String()),
		...errorMapper.toResponseSchemas([CatsError]),
	},
};
const decorate = resultSchema(routeSchema);
declare function methodContext<Method extends (...args: any[]) => unknown>(
	method: Method,
): ClassMethodDecoratorContext<unknown, Method>;

test("accepts synchronous and asynchronous Results, plain payloads, and manual replies", () => {
	class Controller {
		@resultSchema(routeSchema)
		list(req: Request<typeof routeSchema>): Result<string[], CatsError> {
			return req.params.id
				? Result.ok([req.params.id])
				: Result.error(new CatsError());
		}

		@resultSchema(routeSchema)
		async asyncList(): Promise<Result<string[], CatsError>> {
			return Result.ok(["cat"]);
		}

		@resultSchema(routeSchema)
		failure() {
			return Result.error(new CatsError());
		}

		@resultSchema(routeSchema)
		plain() {
			return ["cat"];
		}

		@resultSchema(routeSchema)
		mixed(): string[] | Result<string[], CatsError> {
			return Result.ok(["cat"]);
		}

		@resultSchema(routeSchema)
		manual(
			_req: Request<typeof routeSchema>,
			reply: Reply<typeof routeSchema>,
		) {
			return reply
				.code(404)
				.send({ statusCode: 404, message: "cats.not_found" });
		}

		@resultSchema(routeSchema)
		async asyncManual(
			_req: Request<typeof routeSchema>,
			reply: Reply<typeof routeSchema>,
		) {
			return reply.code(200).send(["cat"]);
		}

		@resultSchema(routeSchema)
		throws(): never {
			throw new Error();
		}
	}

	void Controller;
});

test("rejects invalid Result successes and undeclared or unregistered errors", () => {
	class Controller {
		wrongSuccess() {
			return Result.ok([1]);
		}
		unmapped() {
			return Result.error(new UnmappedError());
		}
		omittedMessage() {
			return Result.error(new TenantError());
		}
		omittedStatus() {
			return Result.error(new AuthError());
		}
		mixedErrors(): Result<string[], CatsError | TenantError> {
			return Result.error(new TenantError());
		}
		unknownError(): Result<string[], unknown> {
			return Result.ok([]);
		}
		anySuccess(): Result<any, CatsError> {
			return Result.ok([]);
		}
		anyError(): Result<string[], any> {
			return Result.ok([]);
		}
		untyped(): any {
			return Result.ok([]);
		}
		async asyncWrong() {
			return Result.ok([1]);
		}
		wrongPlain() {
			return 1;
		}
		missingReturn() {}
	}

	expect(decorate).type.not.toBeCallableWith(
		Controller.prototype.wrongSuccess,
		methodContext(Controller.prototype.wrongSuccess),
	);
	expect(decorate).type.not.toBeCallableWith(
		Controller.prototype.unmapped,
		methodContext(Controller.prototype.unmapped),
	);
	expect(decorate).type.not.toBeCallableWith(
		Controller.prototype.omittedMessage,
		methodContext(Controller.prototype.omittedMessage),
	);
	expect(decorate).type.not.toBeCallableWith(
		Controller.prototype.omittedStatus,
		methodContext(Controller.prototype.omittedStatus),
	);
	expect(decorate).type.not.toBeCallableWith(
		Controller.prototype.mixedErrors,
		methodContext(Controller.prototype.mixedErrors),
	);
	expect(decorate).type.not.toBeCallableWith(
		Controller.prototype.unknownError,
		methodContext(Controller.prototype.unknownError),
	);
	expect(decorate).type.not.toBeCallableWith(
		Controller.prototype.anySuccess,
		methodContext(Controller.prototype.anySuccess),
	);
	expect(decorate).type.not.toBeCallableWith(
		Controller.prototype.anyError,
		methodContext(Controller.prototype.anyError),
	);
	expect(decorate).type.not.toBeCallableWith(
		Controller.prototype.untyped,
		methodContext(Controller.prototype.untyped),
	);
	expect(decorate).type.not.toBeCallableWith(
		Controller.prototype.asyncWrong,
		methodContext(Controller.prototype.asyncWrong),
	);
	expect(decorate).type.not.toBeCallableWith(
		Controller.prototype.wrongPlain,
		methodContext(Controller.prototype.wrongPlain),
	);
	expect(decorate).type.not.toBeCallableWith(
		Controller.prototype.missingReturn,
		methodContext(Controller.prototype.missingReturn),
	);
});

test("matches string status keys, content schemas, and wildcard/default precedence", () => {
	const errorBody = Type.Object({
		statusCode: Type.Literal(404),
		message: Type.Literal("cats.not_found"),
	});
	const stringStatus = resultSchema({ response: { "404": errorBody } });
	const contentStatus = resultSchema({
		response: {
			404: {
				content: {
					"application/json": { schema: errorBody },
				},
			},
		},
	});
	const wildcard = resultSchema({
		response: { "4xx": errorBody, default: Type.Unknown() },
	});
	const fallback = resultSchema({ response: { default: errorBody } });
	const exactFirst = resultSchema({
		response: { 404: errorBody, "4xx": Type.Unknown() },
	});

	class Controller {
		cats() {
			return Result.error(new CatsError());
		}
		tenant() {
			return Result.error(new TenantError());
		}
	}

	expect(stringStatus).type.toBeCallableWith(
		Controller.prototype.cats,
		methodContext(Controller.prototype.cats),
	);
	expect(contentStatus).type.toBeCallableWith(
		Controller.prototype.cats,
		methodContext(Controller.prototype.cats),
	);
	expect(wildcard).type.toBeCallableWith(
		Controller.prototype.cats,
		methodContext(Controller.prototype.cats),
	);
	expect(fallback).type.toBeCallableWith(
		Controller.prototype.cats,
		methodContext(Controller.prototype.cats),
	);
	expect(exactFirst).type.toBeCallableWith(
		Controller.prototype.cats,
		methodContext(Controller.prototype.cats),
	);

	expect(wildcard).type.not.toBeCallableWith(
		Controller.prototype.tenant,
		methodContext(Controller.prototype.tenant),
	);
	expect(exactFirst).type.not.toBeCallableWith(
		Controller.prototype.tenant,
		methodContext(Controller.prototype.tenant),
	);
});
