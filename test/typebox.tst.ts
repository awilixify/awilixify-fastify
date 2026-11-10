import { type Static, Type } from "@sinclair/typebox";
import type { RouteSchema } from "awilixify/http";
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, test } from "tstyche";
import {
	type Reply,
	type Request,
	schema as typeboxSchema,
} from "../lib/typebox.js";

const schema = {
	querystring: Type.Object({ search: Type.Optional(Type.String()) }),
	params: Type.Object({ id: Type.String() }),
	body: Type.Object({ name: Type.String(), active: Type.Boolean() }),
	headers: Type.Object({ "x-tenant": Type.String() }),
} satisfies RouteSchema;

const emptySchema = {} satisfies RouteSchema;

declare const request: Request<typeof schema>;
declare const emptyRequest: Request<typeof emptySchema>;
declare const plainSchemaRequest: Request<{
	body: { type: "object" };
}>;

declare const incompatibleHandler: (
	request: Request<{ body: ReturnType<typeof Type.Number> }>,
) => void;
declare const incompatibleContext: ClassMethodDecoratorContext<
	unknown,
	typeof incompatibleHandler
>;

const responseSchema = Type.Object({ id: Type.String() });
type Response = Static<typeof responseSchema>;

describe("TypeBox request", () => {
	test("schema accepts matching request parameters without changing method types", () => {
		class Controller {
			@typeboxSchema(schema)
			handle(req: Request<typeof schema>, _reply: FastifyReply): string {
				return req.params.id;
			}

			@typeboxSchema(schema)
			async matching(_req: Request<typeof schema>): Promise<string> {
				return "ok";
			}

			@typeboxSchema(schema)
			noParameters() {}
		}
		expect<ReturnType<Controller["handle"]>>().type.toBe<string>();
		expect<ReturnType<Controller["matching"]>>().type.toBe<Promise<string>>();
	});

	test("schema rejects broader request annotations", () => {
		class Controller {
			// @ts-expect-error Unable to resolve signature of method decorator
			@typeboxSchema(schema)
			empty(_req: Request<typeof emptySchema>, _reply: FastifyReply) {}

			// @ts-expect-error Unable to resolve signature of method decorator
			@typeboxSchema(schema)
			broad(_req: FastifyRequest) {}

			// @ts-expect-error Unable to resolve signature of method decorator
			@typeboxSchema(schema)
			untyped(_req: any) {}
		}
		expect<Parameters<Controller["empty"]>[0]>().type.toBe<
			Request<typeof emptySchema>
		>();
	});

	test("schema rejects an incompatible request parameter", () => {
		expect(typeboxSchema(schema)).type.not.toBeCallableWith(
			incompatibleHandler,
			incompatibleContext,
		);
	});

	test("infers query, params, body and headers", () => {
		expect(request.query).type.toBe<{ search?: string }>();
		expect(request.params).type.toBe<{ id: string }>();
		expect(request.body).type.toBe<{ name: string; active: boolean }>();
		expect(request.headers["x-tenant"]).type.toBe<string>();
		expect(request.headers.authorization).type.toBe<string | undefined>();
	});

	test("uses unknown for absent or non-TypeBox schemas", () => {
		expect(emptyRequest.query).type.toBe<unknown>();
		expect(emptyRequest.params).type.toBe<unknown>();
		expect(emptyRequest.body).type.toBe<unknown>();
		expect(plainSchemaRequest.body).type.toBe<unknown>();
	});

	test("works with native replies and explicit response return types", () => {
		const handle = async (
			req: Request<typeof schema>,
			reply: FastifyReply,
		): Promise<Response> => {
			reply.code(201);
			return { id: req.params.id };
		};
		expect<ReturnType<typeof handle>>().type.toBe<Promise<Response>>();
	});
});

const replySchema = {
	params: Type.Object({ id: Type.String() }),
	response: {
		200: Type.Object({ id: Type.String() }),
		404: Type.Object({ message: Type.String() }),
	},
} satisfies RouteSchema;

const stringStatusSchema = {
	response: { "201": Type.Object({ created: Type.Boolean() }) },
};
const wildcardSchema = {
	response: { "4xx": Type.Object({ message: Type.String() }) },
};

declare const reply: Reply<typeof replySchema>;
declare const stringStatusReply: Reply<typeof stringStatusSchema>;
declare const wildcardReply: Reply<typeof wildcardSchema>;
declare const emptyReply: Reply<typeof emptySchema>;

const contentSchema = {
	response: {
		200: {
			content: {
				"application/json": { schema: Type.Object({ id: Type.String() }) },
				"text/plain": { schema: Type.String() },
			},
		},
	},
};
declare const contentReply: Reply<typeof contentSchema>;

describe("TypeBox reply", () => {
	test("infers payloads per status without a type provider", () => {
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
		expect(reply.send).type.toBeCallableWith({ id: "owner-1" });
		expect(reply.send).type.toBeCallableWith({ message: "Missing" });
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

	test("preserves inference through headers and content-type response schemas", () => {
		expect(
			reply.header("x-example", "value").code(200).send,
		).type.toBeCallableWith({ id: "owner-1" });
		expect(
			reply.header("x-example", "value").code(200).send,
		).type.not.toBeCallableWith({ id: 1 });
		expect(contentReply.code(200).send).type.toBeCallableWith({
			id: "owner-1",
		});
		expect(contentReply.code(200).send).type.toBeCallableWith("owner-1");
		expect(contentReply.code(200).send).type.not.toBeCallableWith(123);
	});

	test("uses native replies when no response schema is provided", () => {
		expect(emptyReply).type.toBe<FastifyReply>();
	});

	test("schema accepts matching replies and permits omitted reply parameters", () => {
		class Controller {
			@typeboxSchema(replySchema)
			handle(req: Request<typeof replySchema>, res: Reply<typeof replySchema>) {
				return res.code(200).send({ id: req.params.id });
			}

			@typeboxSchema(replySchema)
			withoutReply(req: Request<typeof replySchema>) {
				return { id: req.params.id };
			}
		}
		expect<Parameters<Controller["handle"]>[1]>().type.toBe<
			Reply<typeof replySchema>
		>();
	});

	test("schema rejects broad and mismatched reply annotations", () => {
		class Controller {
			// @ts-expect-error Unable to resolve signature of method decorator
			@typeboxSchema(replySchema)
			broad(_req: Request<typeof replySchema>, _res: FastifyReply) {}

			// @ts-expect-error Unable to resolve signature of method decorator
			@typeboxSchema(replySchema)
			wrongSchema(
				_req: Request<typeof replySchema>,
				_res: Reply<typeof stringStatusSchema>,
			) {}

			// @ts-expect-error Unable to resolve signature of method decorator
			@typeboxSchema(replySchema)
			untyped(_req: Request<typeof replySchema>, _res: any) {}
		}
		expect<Parameters<Controller["broad"]>[1]>().type.toBe<FastifyReply>();
	});
});
