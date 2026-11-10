import { createDecoratorStateUpdater } from "awilixify";
import type { FastifyContextConfig, RouteOptions } from "fastify";

type FastifyRouteState = {
	config?: FastifyContextConfig;
	constraints?: NonNullable<RouteOptions["constraints"]>;
};

const { update, token } = createDecoratorStateUpdater("fastify-route-state", {
	method: (): FastifyRouteState => ({}),
});

export const FASTIFY_ROUTE_STATE_TOKEN = token;

/**
 * Fastify route config, including options added by plugins such as rate-limit.
 * FastifyContextConfig is empty by default. Plugin types imported by the consuming
 * application augment it through declaration merging, providing config type safety
 * without this package depending on those plugins.
 */
export function routeConfig(config: FastifyContextConfig) {
	return (target: any, context: ClassMethodDecoratorContext) => {
		update(context, {
			method: (previous) => ({
				...previous,
				config: { ...previous.config, ...config },
			}),
		});
		return target;
	};
}

/** Fastify routing constraints, including host, version and custom strategies. */
export function routeConstraints(
	constraints: NonNullable<RouteOptions["constraints"]>,
) {
	return (target: any, context: ClassMethodDecoratorContext) => {
		update(context, {
			method: (previous) => ({
				...previous,
				constraints: { ...previous.constraints, ...constraints },
			}),
		});
		return target;
	};
}
