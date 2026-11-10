import {
	createModule,
	DIContext,
	isResultLike,
	type ModuleDef,
} from "awilixify";
import {
	after as afterHttp,
	before as beforeHttp,
	controller,
	GET,
	POST,
	schema,
} from "awilixify/http";
import Fastify, { type FastifyReply } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type FastifyHandler,
	FastifyModule,
	routeConfig,
	routeConstraints,
} from "../index.js";

const resources: { close(): Promise<unknown> }[] = [];

afterEach(async () => {
	for (const resource of resources.splice(0).reverse()) await resource.close();
});

async function setup(
	Controller: new (...args: any[]) => any,
	handler?: FastifyHandler,
) {
	const fastifyInstance = Fastify();
	resources.push(fastifyInstance);
	const HttpModule = FastifyModule({ fastifyInstance, handler });
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
	it("exports the original instance and registers all paths and verbs", async () => {
		@controller(["/one", "/two"])
		class Controller {
			@GET("/value")
			@POST("/value")
			handle() {
				return { value: 1 };
			}
		}
		const { fastifyInstance, context, HttpModule } = await setup(Controller);
		expect(HttpModule.initializerExports).toEqual(["fastifyInitializer"]);
		expect(HttpModule.initializers.fastifyInitializer.name).toBe(
			"FastifyInitializer",
		);
		expect(context.scope.resolve("fastifyInstance")).toBe(fastifyInstance);
		for (const url of ["/one/value", "/two/value"]) {
			for (const method of ["GET", "POST"] as const) {
				const response = await fastifyInstance.inject({ method, url });
				expect(response.statusCode).toBe(200);
				expect(response.json()).toEqual({ value: 1 });
			}
		}
	});

	it("returns Result-shaped values unchanged by default", async () => {
		class Controller {
			@GET("/success")
			success() {
				return { ok: true, value: { id: 1 } };
			}
			@GET("/failure")
			failure() {
				return { ok: false, error: { message: "Not found" } };
			}
		}
		const { fastifyInstance } = await setup(Controller);
		expect((await fastifyInstance.inject("/success")).json()).toEqual({
			ok: true,
			value: { id: 1 },
		});
		const failure = await fastifyInstance.inject("/failure");
		expect(failure.statusCode).toBe(200);
		expect(failure.json()).toEqual({
			ok: false,
			error: { message: "Not found" },
		});
	});

	it("leaves response status and sending to Fastify", async () => {
		class Controller {
			@GET("/created")
			created(_request: unknown, reply: FastifyReply) {
				reply.code(201);
				return { id: 1 };
			}
			@GET("/empty")
			empty(_request: unknown, reply: FastifyReply) {
				reply.code(202).send();
			}
			@GET("/undefined")
			noResult() {}
		}
		const { fastifyInstance } = await setup(Controller);
		expect((await fastifyInstance.inject("/created")).statusCode).toBe(201);
		expect((await fastifyInstance.inject("/empty")).statusCode).toBe(202);
		const empty = await fastifyInstance.inject("/undefined");
		expect(empty.statusCode).toBe(200);
		expect(empty.body).toBe("");
	});

	it.each([false, true])(
		"does not send again after a manual response, override=%s",
		async (override) => {
			const warn = vi.fn();
			class Controller {
				@GET("/sent")
				async handle(_request: unknown, reply: FastifyReply) {
					vi.spyOn(reply.log, "warn").mockImplementation(warn);
					reply.code(202).send({ sent: true });
					await Promise.resolve();
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
			expect(warn).not.toHaveBeenCalled();
		},
	);

	it("allows a handler override to invoke the controller and transform its result", async () => {
		class Controller {
			@GET("/custom")
			handle(request: { headers: Record<string, unknown> }) {
				return { ok: true, value: request.headers["x-value"] };
			}
		}
		const handler = vi.fn<FastifyHandler>(
			async ({ invoke, request, reply }) => {
				reply.code(201).header("x-path", request.url);
				const result = await invoke();
				return isResultLike(result) && result.ok ? result.value : result;
			},
		);
		const { fastifyInstance } = await setup(Controller, handler);
		const response = await fastifyInstance.inject({
			url: "/custom",
			headers: { "x-value": "custom value" },
		});
		expect(response.statusCode).toBe(201);
		expect(response.body).toBe("custom value");
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

	it("preserves Fastify validation and default serialization", async () => {
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

	it("runs before and after hooks in rolled-up order and exposes route config", async () => {
		const calls: string[] = [];
		@beforeHttp(async () => {
			calls.push("root before");
		})
		@afterHttp(async (_request: unknown, _reply: unknown, payload: string) => {
			calls.push("root after");
			return payload;
		})
		class Controller {
			@GET("/hooks")
			@beforeHttp(async () => {
				calls.push("method before");
			})
			@afterHttp(
				async (_request: unknown, _reply: unknown, payload: string) => {
					calls.push("method after");
					return payload;
				},
			)
			@routeConfig({ marker: "present" })
			handle(request: { routeOptions: { config: Record<string, unknown> } }) {
				calls.push("handler");
				return { marker: request.routeOptions.config.marker };
			}
		}
		const { fastifyInstance } = await setup(Controller);
		expect((await fastifyInstance.inject("/hooks")).json()).toEqual({
			marker: "present",
		});
		expect(calls).toEqual([
			"root before",
			"method before",
			"handler",
			"method after",
			"root after",
		]);
	});

	it("inherits application error handling for controller, hook and override failures", async () => {
		const fastifyInstance = Fastify();
		resources.push(fastifyInstance);
		fastifyInstance.setErrorHandler((_error, _request, reply) =>
			reply.code(418).send({ custom: true }),
		);
		fastifyInstance.get("/native", () => {
			throw new Error("native");
		});
		class Controller {
			@GET("/hook")
			@beforeHttp(async () => {
				throw new Error("hook");
			})
			hook() {
				return "unreachable";
			}
			@GET("/override")
			override() {
				return "unreachable";
			}
			@GET("/decorated")
			handle() {
				throw new Error("decorated");
			}
		}
		const context = DIContext.create({
			name: "App",
			imports: [
				FastifyModule({
					fastifyInstance,
					handler: ({ request, invoke }) => {
						if (request.url === "/override") throw new Error("override");
						return invoke();
					},
				}),
			],
			controllers: [Controller],
		});
		resources.push(context);
		await context.init();
		expect((await fastifyInstance.inject("/native")).statusCode).toBe(418);
		for (const url of ["/decorated", "/hook", "/override"]) {
			const response = await fastifyInstance.inject(url);
			expect(response.statusCode).toBe(418);
			expect(response.json()).toEqual({ custom: true });
		}
	});

	it("routes the same path using host constraints", async () => {
		class Controller {
			@GET("/host")
			@routeConstraints({ host: "api.example.com" })
			api() {
				return "api";
			}
			@GET("/host")
			@routeConstraints({ host: "admin.example.com" })
			admin() {
				return "admin";
			}
		}
		const { fastifyInstance } = await setup(Controller);
		for (const name of ["api", "admin"]) {
			const response = await fastifyInstance.inject({
				url: "/host",
				headers: { host: `${name}.example.com` },
			});
			expect(response.statusCode).toBe(200);
			expect(response.body).toBe(name);
		}
		expect((await fastifyInstance.inject("/host")).statusCode).toBe(404);
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

	it("merges stacked constraints and routes by version", async () => {
		class Controller {
			@GET("/version")
			@routeConstraints({ host: "api.example.com" })
			@routeConstraints({ version: "1.0.0" })
			first() {
				return "v1";
			}
			@GET("/version")
			@routeConstraints({ host: "api.example.com", version: "2.0.0" })
			second() {
				return "v2";
			}
		}
		const { fastifyInstance } = await setup(Controller);
		for (const version of [1, 2]) {
			const response = await fastifyInstance.inject({
				url: "/version",
				headers: { host: "api.example.com", "accept-version": `${version}.x` },
			});
			expect(response.statusCode).toBe(200);
			expect(response.body).toBe(`v${version}`);
		}
		const wrongHost = await fastifyInstance.inject({
			url: "/version",
			headers: { "accept-version": "1.x" },
		});
		expect(wrongHost.statusCode).toBe(404);
	});

	it("registers same-named controllers in separate feature modules", async () => {
		const fastifyInstance = Fastify();
		resources.push(fastifyInstance);
		const Http = FastifyModule({ fastifyInstance });
		const First = class Controller {
			@GET("/first") handle() {
				return "first";
			}
		};
		const Second = class Controller {
			@GET("/second") handle() {
				return "second";
			}
		};
		type Def = ModuleDef<{ imports: [typeof Http] }>;
		const context = DIContext.create({
			name: "App",
			imports: [
				createModule<Def>({
					name: "First",
					imports: [Http],
					controllers: [First],
				}),
				createModule<Def>({
					name: "Second",
					imports: [Http],
					controllers: [Second],
				}),
			],
		});
		resources.push(context);
		await context.init();
		expect((await fastifyInstance.inject("/first")).body).toBe("first");
		expect((await fastifyInstance.inject("/second")).body).toBe("second");
	});

	it("leaves listening and shutdown to the application", async () => {
		const fastifyInstance = Fastify();
		resources.push(fastifyInstance);
		const listen = vi.spyOn(fastifyInstance, "listen");
		const close = vi.spyOn(fastifyInstance, "close");
		const context = DIContext.create({
			name: "App",
			imports: [FastifyModule({ fastifyInstance })],
		});
		await context.init();
		expect(listen).not.toHaveBeenCalled();
		await context.close();
		expect(close).not.toHaveBeenCalled();
	});
});
