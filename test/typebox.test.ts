import { Type } from "@sinclair/typebox";
import { DIContext } from "awilixify";
import { GET } from "awilixify/http";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { FastifyModule } from "../index.js";
import { type Reply, type Request, schema } from "../lib/typebox.js";

it("registers TypeBox schemas through the HTTP initializer without a type provider", async () => {
	const routeSchema = {
		params: Type.Object({ id: Type.String() }),
		querystring: Type.Object({ limit: Type.Integer({ minimum: 1 }) }),
		response: {
			200: Type.Object({ id: Type.String(), limit: Type.Integer() }),
		},
	};

	class Controller {
		@GET("/owners/:id")
		@schema(routeSchema)
		handle(request: Request<typeof routeSchema>) {
			return { id: request.params.id, limit: request.query.limit };
		}

		@GET("/manual/:id")
		@schema(routeSchema)
		manual(
			request: Request<typeof routeSchema>,
			reply: Reply<typeof routeSchema>,
		) {
			return reply
				.code(200)
				.send({ id: request.params.id, limit: request.query.limit });
		}
	}

	const fastifyInstance = Fastify();
	const context = DIContext.create({
		name: "App",
		imports: [FastifyModule({ fastifyInstance })],
		controllers: [Controller],
	});
	try {
		await context.init();
		const valid = await fastifyInstance.inject("/owners/owner-1?limit=2");
		expect(valid.statusCode).toBe(200);
		expect(valid.json()).toEqual({ id: "owner-1", limit: 2 });
		const manual = await fastifyInstance.inject("/manual/owner-1?limit=2");
		expect(manual.statusCode).toBe(200);
		expect(manual.json()).toEqual({ id: "owner-1", limit: 2 });
		const invalid = await fastifyInstance.inject("/owners/owner-1?limit=0");
		expect(invalid.statusCode).toBe(400);
		expect(invalid.json().code).toBe("FST_ERR_VALIDATION");
	} finally {
		await fastifyInstance.close();
		await context.close();
	}
});
