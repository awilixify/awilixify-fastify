import { createModule, type Module, type ModuleDef } from "awilixify";
import { HttpException } from "awilixify/http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { FastifyInitializer } from "./fastify.initializer.js";

// Preserve the application's server, logger and type provider in the internal provider.
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
	/** Send Awilixify HttpException responses. Defaults to true; other errors use the existing handler. */
	handleHttpExceptions?: boolean;
}

export type FastifyModuleDef<
	Instance extends AnyFastifyInstance = AnyFastifyInstance,
> = ModuleDef<{
	providers: {
		fastifyInstance: Instance;
		fastifyOptions: Pick<FastifyModuleOptions, "handler">;
	};
	initializers: { fastifyInitializer: typeof FastifyInitializer };
	exportInitializerKeys: ["fastifyInitializer"];
}>;

export type Deps = FastifyModuleDef["deps"];

function setupHttpExceptionHandler(app: FastifyInstance): void {
	const previousHandler = app.errorHandler;

	app.setErrorHandler((error, request, reply) => {
		if (error instanceof HttpException) {
			return reply.status(error.getStatus()).send(error.getResponse());
		}

		return previousHandler(error, request, reply);
	});
}

let nextId = 0;

export function FastifyModule<Instance extends AnyFastifyInstance>(
	options: FastifyModuleOptions<Instance>,
) {
	const { fastifyInstance, handler, handleHttpExceptions = true } = options;

	if (handleHttpExceptions) setupHttpExceptionHandler(fastifyInstance);

	return createModule<FastifyModuleDef>({
		name: `FastifyModule_${++nextId}`,
		providers: {
			fastifyInstance,
			fastifyOptions: { handler },
		},
		initializers: { fastifyInitializer: FastifyInitializer },
		initializerExports: ["fastifyInitializer"],
	}) as Module<FastifyModuleDef<Instance>>;
}
