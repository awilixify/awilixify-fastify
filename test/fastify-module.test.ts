import { Type } from "@sinclair/typebox";
import { DIContext, Result } from "awilixify";
import {
	after as afterHttp,
	before as beforeHttp,
	controller,
	GET,
	httpException,
	POST,
	schema,
} from "awilixify/http";
import Fastify, { type FastifyReply } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createErrorMapper,
	createResultHandler,
	type FastifyHandler,
	FastifyModule,
	routeConfig,
	routeConstraints,
} from "../index.js";

import {
	createResultSchemaDecorator,
	createErrorMapper as createTypeBoxErrorMapper,
} from "../lib/typebox/index.js";

const resources: { close(): Promise<unknown> }[] = [];

afterEach(async () => {
	for (const resource of resources.splice(0).reverse()) await resource.close();
});

async function setup(
	Controller: new (...args: any[]) => any,
	handler?: FastifyHandler,
	handleHttpExceptions = true,
) {
	const fastifyInstance = Fastify();
	resources.push(fastifyInstance);
	const HttpModule = FastifyModule({
		fastifyInstance,
		handler,
		handleHttpExceptions,
	});
	const context = DIContext.create({
		name: "App",
		imports: [HttpModule],
		controllers: [Controller],
	});
	resources.push(context);

	await context.init();

	return { fastifyInstance, context, HttpModule };
}

describe("Fastify module", () => {
	it("keeps the instance private and registers all paths and verbs", async () => {
		@controller(["/one", "/two"])
		class Controller {
			@GET("/value")
			@POST("/value")
			handle() {
				return { ok: true, value: 1 };
			}
		}
		const { fastifyInstance, context, HttpModule } = await setup(Controller);

		expect(HttpModule.initializerExports).toEqual(["fastifyInitializer"]);
		expect(context.scope.hasRegistration("fastifyInstance")).toBe(false);

		for (const url of ["/one/value", "/two/value"]) {
			for (const method of ["GET", "POST"] as const) {
				const response = await fastifyInstance.inject({ method, url });

				expect(response.statusCode).toBe(200);
				expect(response.json()).toEqual({ ok: true, value: 1 });
			}
		}
	});

	it.each([false, true])(
		"ignores returned data after a manual send without triggering Fastify's duplicate-send warning, override=%s",
		async (override) => {
			const warn = vi.fn();
			class Controller {
				@GET("/sent")
				async handle(_request: unknown, reply: FastifyReply) {
					vi.spyOn(reply.log, "warn").mockImplementation(warn);
					reply.code(202).send({ sent: true });
					await Promise.resolve();
					// Deliberately return data after sending to exercise the reply.sent guard.
					return { ignored: true };
				}
			}
			const { fastifyInstance } = await setup(
				Controller,
				override ? async ({ invoke }) => invoke() : undefined,
			);

			const response = await fastifyInstance.inject("/sent");

			expect(response.statusCode).toBe(202);
			expect(response.json()).toEqual({ sent: true });
			// Without the guard, Fastify tries to send the returned data and logs
			// "Reply was already sent" through reply.log.warn.
			expect(warn).not.toHaveBeenCalled();
		},
	);

	it("allows a handler override to invoke the controller and transform its result", async () => {
		class Controller {
			@GET("/custom")
			handle(request: { headers: Record<string, unknown> }) {
				return request.headers["x-value"];
			}
		}
		const handler = vi.fn<FastifyHandler>(
			async ({ invoke, request, reply }) => {
				reply.code(201).header("x-path", request.url);
				return { value: await invoke() };
			},
		);

		const { fastifyInstance } = await setup(Controller, handler);

		const response = await fastifyInstance.inject({
			url: "/custom",
			headers: { "x-value": "custom value" },
		});

		expect(response.statusCode).toBe(201);
		expect(response.json()).toEqual({ value: "custom value" });
		expect(response.headers["x-path"]).toBe("/custom");
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("allows an override to skip controller invocation", async () => {
		const invoke = vi.fn();
		class Controller {
			@GET("/custom")
			handle() {
				invoke();
				return "controller";
			}
		}
		const { fastifyInstance } = await setup(Controller, () => ({
			custom: true,
		}));
		expect((await fastifyInstance.inject("/custom")).json()).toEqual({
			custom: true,
		});
		expect(invoke).not.toHaveBeenCalled();
	});

	it("forwards request and response schemas to Fastify", async () => {
		class Controller {
			@POST("/validated")
			@schema({
				body: {
					type: "object",
					required: ["name"],
					properties: { name: { type: "string" } },
				},
				response: {
					200: { type: "object", properties: { public: { type: "boolean" } } },
				},
			})
			handle() {
				return { public: true, secret: "must not leak" };
			}
		}

		const { fastifyInstance } = await setup(Controller);

		const invalid = await fastifyInstance.inject({
			method: "POST",
			url: "/validated",
			payload: {},
		});

		expect(invalid.statusCode).toBe(400);
		expect(invalid.json().code).toBe("FST_ERR_VALIDATION");
		const valid = await fastifyInstance.inject({
			method: "POST",
			url: "/validated",
			payload: { name: "Ada" },
		});
		expect(valid.json()).toEqual({ public: true });
	});

	it("maps before and after middleware to Fastify hooks", async () => {
		const calls: string[] = [];
		class Controller {
			@GET("/hooks")
			@beforeHttp(async () => {
				calls.push("before");
			})
			@afterHttp(
				async (_request: unknown, _reply: unknown, payload: string) => {
					calls.push("after");
					return payload;
				},
			)
			handle() {
				calls.push("handler");
				return "ok";
			}
		}

		const { fastifyInstance } = await setup(Controller);

		expect((await fastifyInstance.inject("/hooks")).body).toBe("ok");
		expect(calls).toEqual(["before", "handler", "after"]);
	});

	it("unwraps Results and maps failures without changing plain or sent responses", async () => {
		class CatsError extends Error {
			readonly code = "cats.not_found";
		}
		const errorMapper = createErrorMapper({
			"cats.not_found": [
				CatsError,
				() => httpException.notFound("cats.not_found"),
			],
		});
		const mapError = vi.spyOn(errorMapper, "toHttpErrorFromUnknown");

		class Controller {
			@GET("/plain")
			plain() {
				return { cats: ["cat"] };
			}
			@GET("/ok")
			ok() {
				return Result.ok({ cats: ["cat"] });
			}
			@GET("/mapped")
			mapped() {
				return Result.error(new CatsError());
			}
			@GET("/unknown")
			unknown() {
				return Result.error(new Error("private details"));
			}
			@GET("/sent")
			sent(_request: unknown, reply: FastifyReply) {
				reply.code(202).send({ sent: true });
				return Result.error(new CatsError());
			}
		}

		const { fastifyInstance } = await setup(
			Controller,
			createResultHandler(errorMapper),
			false,
		);
		const errorHandler = vi.fn(
			(_error: unknown, _request: unknown, reply: FastifyReply) =>
				reply.code(500).send({ unexpectedErrorHandler: true }),
		);
		fastifyInstance.setErrorHandler(errorHandler);

		for (const url of ["/plain", "/ok"]) {
			const response = await fastifyInstance.inject(url);
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({ cats: ["cat"] });
		}
		expect(mapError).not.toHaveBeenCalled();

		const mapped = await fastifyInstance.inject("/mapped");
		expect(mapped.statusCode).toBe(404);
		expect(mapped.json()).toEqual({
			statusCode: 404,
			message: "cats.not_found",
		});
		expect(mapError).toHaveBeenCalledTimes(1);

		const unknown = await fastifyInstance.inject("/unknown");
		expect(unknown.statusCode).toBe(500);
		expect(unknown.json()).toEqual({
			statusCode: 500,
			message: "Internal Server Error",
		});
		expect(mapError).toHaveBeenCalledTimes(2);

		const sent = await fastifyInstance.inject("/sent");
		expect(sent.statusCode).toBe(202);
		expect(sent.json()).toEqual({ sent: true });
		expect(mapError).toHaveBeenCalledTimes(2);

		expect(errorHandler).not.toHaveBeenCalled();
	});

	it("serves Result success and error responses using registered schemas", async () => {
		class CatsError extends Error {
			readonly code = "cats.not_found";
		}
		const errorMapper = createTypeBoxErrorMapper({
			"cats.not_found": [
				CatsError,
				() => httpException.notFound("cats.not_found"),
			],
		});
		const resultSchema = createResultSchemaDecorator({ errorMapper });
		const routeSchema = {
			response: {
				200: Type.Array(Type.String()),
				...errorMapper.toResponseSchemas(["cats.not_found"]),
			},
		};
		class Controller {
			@GET("/ok")
			@resultSchema(routeSchema)
			list() {
				return Result.ok(["cat"]);
			}
			@GET("/error")
			@resultSchema(routeSchema)
			failure() {
				return Result.error(new CatsError());
			}
		}
		const { fastifyInstance } = await setup(
			Controller,
			createResultHandler(errorMapper),
		);

		const success = await fastifyInstance.inject("/ok");
		expect(success.statusCode).toBe(200);
		expect(success.json()).toEqual(["cat"]);

		const failure = await fastifyInstance.inject("/error");
		expect(failure.statusCode).toBe(404);
		expect(failure.json()).toEqual({
			statusCode: 404,
			message: "cats.not_found",
		});
	});

	it("sends Awilixify HTTP exception responses by default", async () => {
		class Controller {
			@GET("/error")
			handle() {
				throw httpException.notFound("cats.not_found", {
					detail: "public detail",
				});
			}
		}
		const { fastifyInstance } = await setup(Controller);
		const response = await fastifyInstance.inject("/error");

		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({
			statusCode: 404,
			message: "cats.not_found",
			detail: "public detail",
		});
	});

	it("leaves HTTP exceptions to the application when disabled", async () => {
		const fastifyInstance = Fastify();
		resources.push(fastifyInstance);
		fastifyInstance.setErrorHandler<Error>((error, _request, reply) => {
			return reply.status(503).send({ custom: error.message });
		});
		FastifyModule({ fastifyInstance, handleHttpExceptions: false });
		fastifyInstance.get("/error", () => {
			throw httpException.notFound("cats.not_found");
		});

		const response = await fastifyInstance.inject("/error");
		expect(response.statusCode).toBe(503);
		expect(response.json()).toEqual({ custom: "cats.not_found" });
	});

	it("preserves Fastify default error and validation responses", async () => {
		const plain = Fastify();
		const adapted = Fastify();
		resources.push(plain, adapted);
		FastifyModule({ fastifyInstance: adapted });

		for (const app of [plain, adapted]) {
			app.get("/error", () => {
				throw new Error("unexpected");
			});
			app.get(
				"/validation",
				{
					schema: {
						querystring: {
							type: "object",
							required: ["name"],
							properties: { name: { type: "string" } },
						},
					},
				},
				() => "ok",
			);
		}

		for (const url of ["/error", "/validation"]) {
			const expected = await plain.inject(url);
			const actual = await adapted.inject(url);
			expect(actual.statusCode).toBe(expected.statusCode);
			expect(actual.json()).toEqual(expected.json());
		}
	});

	it("lets controller errors reach the application error handler", async () => {
		const fastifyInstance = Fastify();
		resources.push(fastifyInstance);
		const error = new Error("controller failed");
		const handleError = vi.fn(
			(_error: unknown, _request: unknown, reply: FastifyReply) =>
				reply.code(500).send({ handled: true }),
		);
		fastifyInstance.setErrorHandler(handleError);
		class Controller {
			@GET("/error")
			handle() {
				throw error;
			}
		}

		const context = DIContext.create({
			name: "App",
			imports: [FastifyModule({ fastifyInstance })],
			controllers: [Controller],
		});
		resources.push(context);

		await context.init();
		const response = await fastifyInstance.inject("/error");

		expect(response.statusCode).toBe(500);
		expect(response.json()).toEqual({ handled: true });
		expect(handleError.mock.calls[0]?.[0]).toBe(error);
	});

	it("preserves config and constraints when decorators share route state", async () => {
		class Controller {
			@GET("/combined")
			@routeConfig({ first: true })
			@routeConstraints({ host: "api.example.com" })
			@routeConfig({ second: true })
			@routeConstraints({ version: "1.0.0" })
			handle(request: { routeOptions: { config: Record<string, unknown> } }) {
				const { first, second } = request.routeOptions.config;
				return { first, second };
			}
		}

		const { fastifyInstance } = await setup(Controller);

		const response = await fastifyInstance.inject({
			url: "/combined",
			headers: { host: "api.example.com", "accept-version": "1.x" },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ first: true, second: true });

		const wrongHost = await fastifyInstance.inject({
			url: "/combined",
			headers: { "accept-version": "1.x" },
		});
		expect(wrongHost.statusCode).toBe(404);
		const wrongVersion = await fastifyInstance.inject({
			url: "/combined",
			headers: { host: "api.example.com", "accept-version": "2.x" },
		});
		expect(wrongVersion.statusCode).toBe(404);
	});
});
