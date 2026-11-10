import { createModule, type Module, type ModuleDef } from "awilixify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { FastifyInitializer } from "./fastify.initializer.js";

// Preserve the application's server, logger and type provider in the exported provider.
type AnyFastifyInstance = FastifyInstance<any, any, any, any, any>;

export interface FastifyHandlerContext {
	request: FastifyRequest;
	reply: FastifyReply;
	/** Invoke the controller with the current request and reply. */
	invoke: () => unknown | Promise<unknown>;
}

export type FastifyHandler = (
	context: FastifyHandlerContext,
) => unknown | Promise<unknown>;

export interface FastifyModuleOptions<
	Instance extends AnyFastifyInstance = FastifyInstance,
> {
	fastifyInstance: Instance;
	/** Override request handling. By default, return the controller result unchanged. */
	handler?: FastifyHandler;
}

export type FastifyModuleDef<
	Instance extends AnyFastifyInstance = AnyFastifyInstance,
> = ModuleDef<{
	providers: {
		fastifyInstance: Instance;
		fastifyOptions: Pick<FastifyModuleOptions, "handler">;
	};
	exportKeys: ["fastifyInstance"];
	initializers: { fastifyInitializer: typeof FastifyInitializer };
	exportInitializerKeys: ["fastifyInitializer"];
}>;

export type Deps = FastifyModuleDef["deps"];

let nextId = 0;

export function FastifyModule<Instance extends AnyFastifyInstance>(
	options: FastifyModuleOptions<Instance>,
) {
	const { fastifyInstance, handler } = options;

	return createModule<FastifyModuleDef>({
		name: `FastifyModule_${++nextId}`,
		providers: {
			fastifyInstance,
			fastifyOptions: { handler },
		},
		exports: ["fastifyInstance"],
		initializers: { fastifyInitializer: FastifyInitializer },
		initializerExports: ["fastifyInitializer"],
	}) as Module<FastifyModuleDef<Instance>>;
}
