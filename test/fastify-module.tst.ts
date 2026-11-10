import type { ModuleDef } from "awilixify";
import Fastify, {
	type FastifyReply,
	type FastifyRequest,
	type FastifyTypeProvider,
} from "fastify";
import { describe, expect, test } from "tstyche";
import {
	type FastifyHandler,
	FastifyModule,
	routeConfig,
	routeConstraints,
} from "../index.js";

interface CustomTypeProvider extends FastifyTypeProvider {
	output: this["schema"] extends { type: "string" } ? string : unknown;
}

const fastifyInstance = Fastify().withTypeProvider<CustomTypeProvider>();
const HttpModule = FastifyModule({ fastifyInstance });
type Def = ModuleDef<{ imports: [typeof HttpModule] }>;
declare const deps: Def["deps"];

const defaultApp = Fastify();
const defaultModule = FastifyModule({ fastifyInstance: defaultApp });
type DefaultDef = ModuleDef<{ imports: [typeof defaultModule] }>;
declare const defaultDeps: DefaultDef["deps"];

describe("Fastify module types", () => {
	test("preserves the application's Fastify type provider", () => {
		expect(deps.fastifyInstance).type.toBe<typeof fastifyInstance>();
		expect(defaultDeps.fastifyInstance).type.toBe<typeof defaultApp>();
	});

	test("requires an instance and types handler context", () => {
		expect(FastifyModule).type.not.toBeCallableWith({});
		expect(FastifyModule).type.not.toBeCallableWith({
			fastifyInstance: {},
		});
		const handler: FastifyHandler = async ({ request, reply, invoke }) => {
			expect(request).type.toBe<FastifyRequest>();
			expect(reply).type.toBe<FastifyReply>();
			expect(invoke).type.toBe<() => unknown | Promise<unknown>>();
			return invoke();
		};
		FastifyModule({ fastifyInstance, handler });
	});

	test("accepts native routing constraints", () => {
		routeConstraints({ host: "api.example.com", version: "1.0.0" });
		routeConstraints({ host: /example\.com$/, tenant: "custom" });
		expect(routeConstraints).type.not.toBeCallableWith({ version: 1 });
		expect(routeConstraints).type.not.toBeCallableWith({ host: 123 });
	});

	test("accepts native Fastify route configuration", () => {
		routeConfig({ custom: "value" });
	});
});
