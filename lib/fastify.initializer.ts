import {
	Initializer,
	type InitializerContext,
	resolveDecoratorState,
} from "awilixify";
import {
	HTTP_DECORATOR_STATE_TOKEN,
	rollUpHttpDecoratorState,
} from "awilixify/http";
import type { FastifyReply, FastifyRequest, FastifySchema } from "fastify";
import type { Deps } from "./fastify.module.js";
import { FASTIFY_ROUTE_STATE_TOKEN } from "./fastify-route.decorators.js";

export class FastifyInitializer extends Initializer<
	typeof HTTP_DECORATOR_STATE_TOKEN
> {
	readonly token = HTTP_DECORATOR_STATE_TOKEN;

	constructor(
		private readonly fastifyInstance: Deps["fastifyInstance"],
		private readonly fastifyOptions: Deps["fastifyOptions"],
	) {
		super();
	}

	initialize(
		context: InitializerContext<typeof HTTP_DECORATOR_STATE_TOKEN>,
	): void {
		const state = rollUpHttpDecoratorState(
			context.decoratorState.root,
			context.metadata,
		);
		const routeState = resolveDecoratorState(
			context.target,
			FASTIFY_ROUTE_STATE_TOKEN,
		)?.methods.get(context.methodName);

		const handler = async (request: FastifyRequest, reply: FastifyReply) => {
			const invoke = () => context.invoke(request, reply);

			const result = await (this.fastifyOptions.handler
				? this.fastifyOptions.handler({ request, reply, invoke })
				: invoke());

			return reply.sent ? reply : result;
		};

		for (const method of state.verbs) {
			for (const url of state.paths) {
				this.fastifyInstance.route({
					method,
					url,
					config: routeState?.config,
					constraints: routeState?.constraints,
					schema: state.schema as FastifySchema,
					preHandler: state.beforeMiddleware,
					onSend: state.afterMiddleware,
					handler,
				});
			}
		}
	}
}
