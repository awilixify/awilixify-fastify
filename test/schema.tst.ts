import { type Static, Type } from "@sinclair/typebox";
import { Result } from "awilixify";
import type { RouteSchema } from "awilixify/http";
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, test } from "tstyche";
import {
	type Reply,
	type Request,
	schema as typeboxSchema,
} from "../lib/typebox/index.js";

const responseSchema = Type.Object({ id: Type.String() });
type Response = Static<typeof responseSchema>;

const schema = {
	querystring: Type.Object({ search: Type.Optional(Type.String()) }),
	params: Type.Object({ id: Type.String() }),
	body: Type.Object({ name: Type.String(), active: Type.Boolean() }),
	headers: Type.Object({ "x-tenant": Type.String() }),
	response: {
		200: responseSchema,
		404: Type.Object({ message: Type.String() }),
	},
} satisfies RouteSchema;

const decorate = typeboxSchema(schema);

const emptySchema = {} satisfies RouteSchema;
const stringStatusSchema = {
	response: { "201": Type.Object({ created: Type.Boolean() }) },
};
const wildcardSchema = {
	response: { "4xx": Type.Object({ message: Type.String() }) },
};
const contentSchema = {
	response: {
		200: {
			content: {
				"application/json": { schema: responseSchema },
				"text/plain": { schema: Type.String() },
			},
		},
	},
};

declare const request: Request<typeof schema>;
declare const reply: Reply<typeof schema>;
declare const emptyRequest: Request<typeof emptySchema>;
declare const emptyReply: Reply<typeof emptySchema>;
declare const plainSchemaRequest: Request<{ body: { type: "object" } }>;
declare const stringStatusReply: Reply<typeof stringStatusSchema>;
declare const wildcardReply: Reply<typeof wildcardSchema>;
declare const contentReply: Reply<typeof contentSchema>;

declare function methodContext<Method extends (...args: any[]) => unknown>(
	method: Method,
): ClassMethodDecoratorContext<unknown, Method>;

describe("TypeBox controller contract", () => {
	test("checks a complete schema while preserving inferred method types", () => {
		class Controller {
			@typeboxSchema(schema)
			handle(req: Request<typeof schema>, _res: Reply<typeof schema>) {
				expect(req.headers).type.toBe<
					FastifyRequest["headers"] & { "x-tenant": string }
				>();

				return { id: req.params.id };
			}

			@typeboxSchema(schema)
			async asyncResult(req: Request<typeof schema>) {
				return { id: req.params.id };
			}

			@typeboxSchema(schema)
			withoutParameters() {
				return { id: "owner-1" };
			}

			@typeboxSchema(schema)
			alwaysThrows(): never {
				throw new Error("Unavailable");
			}
		}

		expect<Parameters<Controller["handle"]>[0]>().type.toBe<
			Request<typeof schema>
		>();
		expect<Parameters<Controller["handle"]>[1]>().type.toBe<
			Reply<typeof schema>
		>();
		expect<ReturnType<Controller["handle"]>>().type.toBe<Response>();
		expect<ReturnType<Controller["asyncResult"]>>().type.toBe<
			Promise<Response>
		>();
	});

	test("infers every request field and status-specific response payload", () => {
		expect(request.query).type.toBe<{ search?: string }>();
		expect(request.params).type.toBe<{ id: string }>();
		expect(request.body).type.toBe<{ name: string; active: boolean }>();
		expect(request.headers["x-tenant"]).type.toBe<string>();
		expect(request.headers.authorization).type.toBe<string | undefined>();

		expect(reply.code(200).send).type.toBeCallableWith({ id: "owner-1" });
		expect(reply.code(200).send).type.not.toBeCallableWith({ id: 1 });
		expect(reply.code(200).send).type.not.toBeCallableWith({
			message: "Missing",
		});
		expect(reply.status(404).send).type.toBeCallableWith({
			message: "Missing",
		});
		expect(reply.status(404).send).type.not.toBeCallableWith({ id: "owner-1" });
		expect(reply.code).type.not.toBeCallableWith(201);
		expect(reply.status).type.not.toBeCallableWith(201);
		expect(reply.send).type.toBeCallableWith({ id: "owner-1" });
		// Native Fastify typing accepts every declared response payload here, even
		// though plain send() defaults to 200. Preserved for compatibility; use code(404).
		expect(reply.send).type.toBeCallableWith({ message: "Missing" });
	});

	test("accepts returned synchronous and asynchronous manual replies", () => {
		void class {
			@typeboxSchema(schema)
			manual(_req: Request<typeof schema>, res: Reply<typeof schema>) {
				return res.code(404).send({ message: "Missing" });
			}

			@typeboxSchema(schema)
			async asyncManual(
				_req: Request<typeof schema>,
				res: Reply<typeof schema>,
			) {
				return res.code(404).send({ message: "Missing" });
			}
		};
	});
});

describe("TypeBox request matching", () => {
	test("rejects broad, untyped and incompatible request parameters", () => {
		class Controller {
			empty(_req: Request<typeof emptySchema>) {
				return { id: "owner-1" };
			}
			broad(_req: FastifyRequest) {
				return { id: "owner-1" };
			}
			untyped(_req: any) {
				return { id: "owner-1" };
			}
			incompatible(_req: Request<{ body: ReturnType<typeof Type.Number> }>) {
				return { id: "owner-1" };
			}
		}
		expect(decorate).type.not.toBeCallableWith(
			Controller.prototype.empty,
			methodContext(Controller.prototype.empty),
		);
		expect(decorate).type.not.toBeCallableWith(
			Controller.prototype.broad,
			methodContext(Controller.prototype.broad),
		);
		expect(decorate).type.not.toBeCallableWith(
			Controller.prototype.untyped,
			methodContext(Controller.prototype.untyped),
		);
		expect(decorate).type.not.toBeCallableWith(
			Controller.prototype.incompatible,
			methodContext(Controller.prototype.incompatible),
		);

		type BroadError = Parameters<
			typeof decorate<unknown, Controller["broad"]>
		>[0];
		type AnyError = Parameters<
			typeof decorate<unknown, Controller["untyped"]>
		>[0];
		expect<
			BroadError["__schemaError"]
		>().type.toBe<"Request parameter must match the route schema">();
		expect<BroadError["expected"]>().type.toBe<Request<typeof schema>>();
		expect<BroadError["actual"]>().type.toBe<FastifyRequest>();
		expect<
			AnyError["__schemaError"]
		>().type.toBe<"Request parameter must not be any">();
	});
});

describe("TypeBox reply matching", () => {
	test("rejects broad, untyped and mismatched reply parameters", () => {
		class Controller {
			broad(_req: Request<typeof schema>, _res: FastifyReply) {
				return { id: "owner-1" };
			}
			wrongSchema(
				_req: Request<typeof schema>,
				_res: Reply<typeof stringStatusSchema>,
			) {
				return { id: "owner-1" };
			}
			untyped(_req: Request<typeof schema>, _res: any) {
				return { id: "owner-1" };
			}
		}

		expect(decorate).type.not.toBeCallableWith(
			Controller.prototype.broad,
			methodContext(Controller.prototype.broad),
		);
		expect(decorate).type.not.toBeCallableWith(
			Controller.prototype.wrongSchema,
			methodContext(Controller.prototype.wrongSchema),
		);
		expect(decorate).type.not.toBeCallableWith(
			Controller.prototype.untyped,
			methodContext(Controller.prototype.untyped),
		);

		type BroadError = Parameters<
			typeof decorate<unknown, Controller["broad"]>
		>[0];
		type AnyError = Parameters<
			typeof decorate<unknown, Controller["untyped"]>
		>[0];
		expect<
			BroadError["__schemaError"]
		>().type.toBe<"Reply parameter must match the route schema">();
		expect<BroadError["expected"]>().type.toBe<Reply<typeof schema>>();
		expect<BroadError["actual"]>().type.toBe<FastifyReply>();
		expect<
			AnyError["__schemaError"]
		>().type.toBe<"Reply parameter must not be any">();
	});
});

describe("TypeBox return matching", () => {
	test("rejects Result wrappers even when the success value matches response[200]", () => {
		class Controller {
			returnsResult() {
				return Result.ok({ id: "owner-1" });
			}
			returnsError() {
				return Result.error({ message: "Missing" });
			}
		}
		expect(decorate).type.not.toBeCallableWith(
			Controller.prototype.returnsResult,
			methodContext(Controller.prototype.returnsResult),
		);
		expect(decorate).type.not.toBeCallableWith(
			Controller.prototype.returnsError,
			methodContext(Controller.prototype.returnsError),
		);
	});

	test("rejects incompatible inferred and annotated returns", () => {
		class Controller {
			wrongShape() {
				return { wrong: true };
			}
			async wrongAsync(): Promise<string> {
				return "wrong";
			}
			wrongField() {
				return { id: 1 };
			}
			missingReturn() {}
			untyped(): any {
				return {};
			}
			async untypedAsync(): Promise<any> {
				return {};
			}
		}

		expect(decorate).type.not.toBeCallableWith(
			Controller.prototype.wrongShape,
			methodContext(Controller.prototype.wrongShape),
		);
		expect(decorate).type.not.toBeCallableWith(
			Controller.prototype.wrongAsync,
			methodContext(Controller.prototype.wrongAsync),
		);
		expect(decorate).type.not.toBeCallableWith(
			Controller.prototype.wrongField,
			methodContext(Controller.prototype.wrongField),
		);
		expect(decorate).type.not.toBeCallableWith(
			Controller.prototype.missingReturn,
			methodContext(Controller.prototype.missingReturn),
		);
		expect(decorate).type.not.toBeCallableWith(
			Controller.prototype.untyped,
			methodContext(Controller.prototype.untyped),
		);
		expect(decorate).type.not.toBeCallableWith(
			Controller.prototype.untypedAsync,
			methodContext(Controller.prototype.untypedAsync),
		);

		type FieldError = Parameters<
			typeof decorate<unknown, Controller["wrongField"]>
		>[0];
		type AnyError = Parameters<
			typeof decorate<unknown, Controller["untypedAsync"]>
		>[0];
		expect<
			FieldError["__schemaError"]
		>().type.toBe<"Return payload must match response[200]">();
		expect<FieldError["expected"]>().type.toBe<Response>();
		expect<FieldError["actual"]>().type.toBe<{ id: number }>();
		expect<
			AnyError["__schemaError"]
		>().type.toBe<"Return type must not be any">();
	});

	test("rejects forgotten manual returns and plain payloads for another status", () => {
		class Controller {
			async asyncNoReturn(
				_req: Request<typeof schema>,
				res: Reply<typeof schema>,
			) {
				res.code(200).send({ id: "owner-1" });
			}
			noReturn(_req: Request<typeof schema>, res: Reply<typeof schema>) {
				res.code(200).send({ id: "owner-1" });
			}
			forgottenReturn(
				_req: Request<typeof schema>,
				_res: Reply<typeof schema>,
			) {}
			mixedPaths(req: Request<typeof schema>, res: Reply<typeof schema>) {
				if (req.params.id === "missing") {
					res.code(404).send({ message: "Missing" });
					return;
				}
				return { id: req.params.id };
			}
			wrongStatusReturn(
				_req: Request<typeof schema>,
				res: Reply<typeof schema>,
			) {
				res.code(404);
				return { message: "Missing" };
			}
		}

		expect(decorate).type.not.toBeCallableWith(
			Controller.prototype.asyncNoReturn,
			methodContext(Controller.prototype.asyncNoReturn),
		);
		expect(decorate).type.not.toBeCallableWith(
			Controller.prototype.noReturn,
			methodContext(Controller.prototype.noReturn),
		);
		expect(decorate).type.not.toBeCallableWith(
			Controller.prototype.forgottenReturn,
			methodContext(Controller.prototype.forgottenReturn),
		);
		expect(decorate).type.not.toBeCallableWith(
			Controller.prototype.mixedPaths,
			methodContext(Controller.prototype.mixedPaths),
		);
		expect(decorate).type.not.toBeCallableWith(
			Controller.prototype.wrongStatusReturn,
			methodContext(Controller.prototype.wrongStatusReturn),
		);
	});
});

describe("TypeBox schema edge cases", () => {
	test("uses unknown for absent or non-TypeBox request schemas", () => {
		expect(emptyRequest.query).type.toBe<unknown>();
		expect(emptyRequest.params).type.toBe<unknown>();
		expect(emptyRequest.body).type.toBe<unknown>();
		expect(plainSchemaRequest.body).type.toBe<unknown>();
		expect(emptyReply).type.toBe<FastifyReply>();
	});

	test("supports numeric string and wildcard status keys", () => {
		expect(stringStatusReply.code(201).send).type.toBeCallableWith({
			created: true,
		});
		expect(stringStatusReply.code(201).send).type.not.toBeCallableWith({
			created: "yes",
		});
		expect(wildcardReply.code(429).send).type.toBeCallableWith({
			message: "Slow down",
		});
		expect(wildcardReply.code(429).send).type.not.toBeCallableWith({
			message: 1,
		});
	});

	test("infers reply payloads from content-type response schemas", () => {
		expect(contentReply.code(200).send).type.toBeCallableWith({
			id: "owner-1",
		});
		expect(contentReply.code(200).send).type.toBeCallableWith("owner-1");
		expect(contentReply.code(200).send).type.not.toBeCallableWith(123);
	});

	test("checks string and content-type return payloads", () => {
		const textSchema = { response: { "200": Type.String() } };
		const textDecorator = typeboxSchema(textSchema);
		const contentDecorator = typeboxSchema(contentSchema);
		class Controller {
			@typeboxSchema(textSchema)
			text() {
				return "hello";
			}

			@typeboxSchema(contentSchema)
			content() {
				return { id: "owner-1" };
			}

			@typeboxSchema(contentSchema)
			textContent() {
				return "owner-1";
			}

			wrong() {
				return 123;
			}

			wrongContentField() {
				return { id: 123 };
			}
		}

		expect(textDecorator).type.not.toBeCallableWith(
			Controller.prototype.wrong,
			methodContext(Controller.prototype.wrong),
		);
		expect(contentDecorator).type.not.toBeCallableWith(
			Controller.prototype.wrong,
			methodContext(Controller.prototype.wrong),
		);
		expect(contentDecorator).type.not.toBeCallableWith(
			Controller.prototype.wrongContentField,
			methodContext(Controller.prototype.wrongContentField),
		);
		expect<ReturnType<Controller["text"]>>().type.toBe<string>();
		expect<ReturnType<Controller["content"]>>().type.toBe<Response>();
		expect<ReturnType<Controller["textContent"]>>().type.toBe<string>();
	});

	test("does not constrain returns without an inferable response 200", () => {
		const plainJsonSchema = { response: { 200: { type: "string" } } };
		const requestOnlySchema = { params: schema.params };
		class Controller {
			@typeboxSchema(emptySchema)
			noResponse() {
				return { anything: true };
			}

			@typeboxSchema(stringStatusSchema)
			only201() {
				return "unconstrained";
			}

			@typeboxSchema(plainJsonSchema)
			nonTypeBox() {
				return "unconstrained";
			}

			@typeboxSchema(requestOnlySchema)
			requestOnly(
				_req: Request<typeof requestOnlySchema>,
				_res: FastifyReply,
			) {}
		}
		expect<ReturnType<Controller["noResponse"]>>().type.toBe<{
			anything: boolean;
		}>();
		expect<ReturnType<Controller["requestOnly"]>>().type.toBe<void>();
	});
});
