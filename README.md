# @awilixify/fastify

Fastify HTTP controllers for Awilixify, with an optional request-handler override.

## Install

```sh
npm install @awilixify/fastify awilixify awilix fastify
```

Requires Node.js 22+, Awilixify 3.4, and Fastify 5. TypeScript examples use standard decorators, not `experimentalDecorators`.

## Usage

```ts
import { DIContext } from "awilixify";
import { controller, GET } from "awilixify/http";
import { FastifyModule } from "@awilixify/fastify";
import Fastify from "fastify";

const fastifyInstance = Fastify({ logger: true });
const HttpModule = FastifyModule({ fastifyInstance });

@controller("/users")
class UsersController {
	@GET("/")
	list() {
		return [{ id: 1, name: "Ada" }];
	}
}

const context = DIContext.create({
	name: "App",
	imports: [HttpModule],
	controllers: [UsersController],
});

await context.init();
await fastifyInstance.listen({ port: 3000 });

// During application shutdown, stop requests before disposing DI resources:
// await fastifyInstance.close();
// await context.close();
```

The module exports the original instance as `fastifyInstance`, retaining its server, logger and type-provider types. It exports the Fastify initializer as `fastifyInitializer`. Import the same `HttpModule` into each feature module that declares HTTP controllers.

Configure Fastify options, plugins and hooks on the instance yourself. Register plugins before initializing the DI context, and initialize the context before calling `fastifyInstance.ready()`, `fastifyInstance.inject()` or `fastifyInstance.listen()`.

The integration does not listen automatically, install plugins, choose a schema library, or augment request/context types. Fastify's validation and serialization compilers remain unchanged. TypeBox and other providers can be configured on the supplied instance.

## TypeBox types

Install TypeBox to use the optional `Request<S>`, `Reply<S>`, and signature-checked `schema()` decorator:

```sh
npm install @sinclair/typebox
```

```ts
import { type Request, schema } from "@awilixify/fastify/typebox";
import { type Static, Type } from "@sinclair/typebox";
import { GET } from "awilixify/http";

const getUserSchema = {
	params: Type.Object({ id: Type.String() }),
	response: {
		200: Type.Object({ id: Type.String(), name: Type.String() }),
	},
};

type GetUserResponse = Static<typeof getUserSchema.response[200]>;

class UsersController {
	@GET("/users/:id")
	@schema(getUserSchema)
	async getUser(request: Request<typeof getUserSchema>): Promise<GetUserResponse> {
		return { id: request.params.id, name: "Ada" };
	}
}
```

The helper infers body, params, query and headers from TypeBox schemas. Missing or non-TypeBox schemas fall back to `unknown`, with native Fastify header types retained. The `/typebox` version of `@schema()` requires the annotated request type to match the schema-derived request in both directions. Broader annotations such as `Request<typeof emptySchema>`, plain `FastifyRequest`, and `any` are rejected for a typed schema. Methods without parameters are allowed. Parameter annotations are still explicit, and matching is structural, not based on schema object identity.

When a second parameter is declared, the decorator also requires it to match `Reply<typeof routeSchema>`. For a schema without response definitions, `Reply<S>` is the native `FastifyReply`. The decorator delegates runtime registration to `awilixify/http`'s `schema()` and does not check returned payloads; use explicit return types for those.

For manual responses, `Reply<S>` derives payload types from the response schemas:

```ts
import type { Reply, Request } from "@awilixify/fastify/typebox";

class ManualUsersController {
	@GET("/users/:id")
	@schema(getUserSchema)
	getUser(
		request: Request<typeof getUserSchema>,
		reply: Reply<typeof getUserSchema>,
	) {
		return reply.code(200).send({ id: request.params.id, name: "Ada" });
	}
}
```

Calling `.code()` or `.status()` selects the corresponding payload type. Plain `.send()` accepts the union of declared response payloads and does not select a status automatically. Reply inference also supports content-type response schemas through Fastify's native types. Non-TypeBox payload schemas fall back to `unknown`.

These helpers use only Fastify and TypeBox types. Neither `@fastify/type-provider-typebox` nor `.withTypeProvider()` is needed, and runtime validation and serialization remain unchanged.

TypeBox is an optional peer dependency, only needed when importing the `/typebox` subpath. The root entry point does not export or reference the TypeBox helpers.

## Request handling

By default, the route handler invokes the controller with the native Fastify request and reply and returns its result. After either the default invocation or a custom handler, an already-sent or hijacked reply is returned instead of the result to prevent a second send. There is no Result unwrapping, error mapping, status selection, or route-level error handler. A returned `{ ok, value/error }` object is sent as-is.

Fastify controls response serialization and error handling. Use `fastifyInstance.setErrorHandler()` on your supplied instance to handle thrown errors. Controller and hook errors reach that inherited handler.

Fastify's normal rules also apply to empty responses. Returning `undefined` from the async route handler sends an empty response with the current status, normally 200. Explicitly send `reply.code(204).send()` when you want a 204.

### Override the handler

Provide `handler` to customize decorated routes. It runs per request and receives `request`, `reply`, and `invoke()`. Calling `invoke()` executes the controller with that request and reply. The callback can transform the result, catch errors, or skip controller invocation entirely.

For example, an application can opt into Result unwrapping:

```ts
import { isResultLike } from "awilixify";

const HttpModule = FastifyModule({
	fastifyInstance,
	handler: async ({ invoke, reply }) => {
		const result = await invoke();
		if (reply.sent) return reply;
		if (isResultLike(result)) {
			if (!result.ok) throw result.error;
			return result.value;
		}
		return result;
	},
});
```

Thrown errors from the override also use Fastify's error handling. The override does not replace lifecycle hooks, validation, or serialization.

## Hooks and route config

Awilixify's `@before` hooks become Fastify `preHandler` hooks. `@after` hooks become `onSend` hooks and must use Fastify's `onSend` signature. Class and method hooks run in Awilixify's rolled-up order: class before, method before, handler, method after, class after.

Use `@schema` from `awilixify/http` for validation and response schemas. Use `@routeConfig` for native Fastify route config, including fields added by installed plugins:

```ts
import rateLimit from "@fastify/rate-limit";
import { routeConfig } from "@awilixify/fastify";
import { GET } from "awilixify/http";

fastifyInstance.register(rateLimit, { global: false });

class SearchController {
	@GET("/search")
	@routeConfig({ rateLimit: { max: 20, timeWindow: "1 minute" } })
	search() {
		return [];
	}
}
```

The rate-limit plugin is an application dependency, not a dependency of this package.

## Route constraints

Use `@routeConstraints()` for Fastify's host, version, or custom routing constraints:

```ts
import { routeConstraints } from "@awilixify/fastify";

class VersionedController {
	@GET("/users")
	@routeConstraints({ host: "api.example.com", version: "1.0.0" })
	list() {
		return [];
	}
}
```

Version constraints match the request's `Accept-Version` header. Register custom constraint strategies on the supplied Fastify instance before DI initialization. Stacked decorators shallow-merge their constraints. Like `@routeConfig()`, this decorator applies to methods with HTTP route metadata and does not register a route by itself.

## Shutdown

The application owns the supplied instance and its lifecycle. Register plugins before DI initialization and listen after all routes have been registered, for example in an eager application provider's `afterInit()`. The module never calls `listen()` or `close()`. During shutdown, await `fastifyInstance.close()` before `context.close()` so active requests drain before their dependencies are disposed.

## Development

```sh
npm install
npm run build:release
```
# awilixify-fastify
