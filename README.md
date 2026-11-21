# @awilixify/fastify

Register Awilixify controllers as Fastify routes. Optionally add typed TypeBox schemas and map application Result errors to HTTP responses.

## Install

```sh
npm install @awilixify/fastify awilixify awilix fastify
```

## Quick start

Let an infrastructure module own the Fastify instance and server lifecycle:

```ts
// http-infra.module.ts
import { Lifetime } from "awilix";
import { createModule, type ModuleDef } from "awilixify";
import Fastify, { type FastifyInstance } from "fastify";

class HttpServer {
  constructor(private readonly fastifyInstance: FastifyInstance) {}

  onInit() {
    // Register application plugins here, before controller routes are added.
    // Do not call ready(), inject(), or listen() in this phase.
  }

  async afterInit() {
    await this.fastifyInstance.listen({ port: 3000 });
  }

  async beforeShutdown() {
    await this.fastifyInstance.close();
  }
}

type HttpInfraModuleDef = ModuleDef<{
  providers: {
    fastifyInstance: FastifyInstance;
    httpServer: HttpServer;
  };
  exportKeys: ["fastifyInstance"];
}>;

export const HttpInfraModule = createModule<HttpInfraModuleDef>({
  name: "HttpInfraModule",
  providers: {
    fastifyInstance: {
      useFactory: () => Fastify({ logger: true }),
      lifetime: Lifetime.SINGLETON,
    },
    httpServer: {
      useClass: HttpServer,
      lifetime: Lifetime.SINGLETON,
      eager: true,
    },
  },
  exports: ["fastifyInstance"],
});
```

Pass that singleton to the integration with `configureModule`:

```ts
// http.module.ts
import { FastifyModule } from "@awilixify/fastify";
import { configureModule } from "awilixify";
import { HttpInfraModule } from "./http-infra.module.js";

export const HttpModule = configureModule({
  imports: [HttpInfraModule],
  inject: ["fastifyInstance"],
  useFactory: (fastifyInstance) => FastifyModule({ fastifyInstance }),
});
```

Configuration imports stay registered through shutdown, even though the returned Fastify module does not import them. `HttpServer` and the integration use the same singleton. Only Fastify's exported initializer becomes global; the instance stays private to the integration and infrastructure modules.

Feature modules declare their own controllers:

```ts
// users.module.ts
import { createModule } from "awilixify";
import { controller, GET } from "awilixify/http";

@controller("/users")
class UsersController {
  @GET("/")
  list() {
    return [{ id: 1, name: "Ada" }];
  }
}

export const UsersModule = createModule({
  name: "UsersModule",
  controllers: [UsersController],
});
```

Register `HttpModule` globally so feature modules don't need HTTP imports:

```ts
// main.ts
import { DIContext } from "awilixify";
import { HttpModule } from "./http.module.js";
import { UsersModule } from "./users.module.js";

const context = DIContext.create(
  { name: "App", imports: [UsersModule] },
  { globalModules: [HttpModule] },
);

await context.init();
```

Initialization runs `HttpServer.onInit()`, registers controller routes, then runs `HttpServer.afterInit()` to start listening. The integration itself only registers routes and configures request handling; your infrastructure provider owns plugins and server lifecycle.

## Typed schemas

The optional `/typebox` helpers check controller signatures against route schemas. No Fastify TypeBox provider is required.

```sh
npm install @sinclair/typebox
```

```ts
import { type Request, schema } from "@awilixify/fastify/typebox";
import { Type } from "@sinclair/typebox";

const userSchema = {
  params: Type.Object({ id: Type.String() }),
  response: { 200: Type.Object({ id: Type.String() }) },
};

class UsersController {
  @GET("/users/:id")
  @schema(userSchema)
  getUser(request: Request<typeof userSchema>) {
    return { id: request.params.id };
  }
}
```

`Request<S>` types request fields. `schema()` checks request/reply annotations and plain success returns against `response[200]` when inferable.

For explicit responses, annotate the second parameter as `Reply<typeof userSchema>` and return the reply:

```ts
return reply.code(200).send({ id: request.params.id });
```

`Reply<S>` checks declared statuses and their response bodies. Use `.code()` or `.status()` to select a response; plain `.send()` doesn't narrow by status

## Results and application errors

Define HTTP mappings once. Reuse them to handle failed Results and generate response schemas, so controller types and documented responses stay consistent. Add the handler to the quick start's configuration factory:

```ts
import {
  createErrorMapper,
  createResultSchemaDecorator,
  defineErrorMappings,
} from "@awilixify/fastify/typebox";
import { createResultHandler } from "@awilixify/fastify";
import { Result } from "awilixify";
import { httpException } from "awilixify/http";

class CatsNotFoundError extends Error {}

const catsErrors = defineErrorMappings({
  "cats.not_found": [CatsNotFoundError, () => httpException.notFound("No cats found")],
});
const errorMapper = createErrorMapper({ ...catsErrors });
const resultSchema = createResultSchemaDecorator({ errorMapper });

const HttpModule = configureModule({
  imports: [HttpInfraModule],
  inject: ["fastifyInstance"],
  useFactory: (fastifyInstance) => FastifyModule({
    fastifyInstance,
    handler: createResultHandler(errorMapper),
  }),
});
```

Select the errors each route documents:

```ts
const catsSchema = {
  response: {
    200: Type.Array(Type.String()),
    ...errorMapper.toResponseSchemas(["cats.not_found"]),
  },
};

class CatsController {
  @GET("/cats")
  @resultSchema(catsSchema)
  list(): Result<string[], CatsNotFoundError> {
    return Result.error(new CatsNotFoundError());
  }
}
```

The decorator checks that success values fit `response[200]` and every returned error is registered and maps to an allowed route response. Schemas may document additional errors from middleware or validation.

### Module maps and default errors

Export each module's registrations through `defineErrorMappings`, then combine them with object spreads:

```ts
const errorMapper = createErrorMapper(
  { ...catsErrors, ...authErrors, ...tenantErrors },
  { defaultErrors: ["auth.unauthorized", "tenant.not_found"] },
);

errorMapper.toResponseSchemas(); // Defaults only.
errorMapper.toResponseSchemas(["cats.not_found"]); // Defaults plus route errors.
errorMapper.toResponseSchemas(["cats.not_found"], {
  excludeDefaults: ["auth.unauthorized"],
});
```

- Keys provide autocomplete and schema selection. Factories define the HTTP status and message shown in Swagger.
- `defineErrorMappings` preserves literal types without `as const`. Use it for each module before spreading maps to detect duplicate keys. Duplicate constructors also throw.
- `defaultErrors` documents responses without changing runtime handling. `excludeDefaults` accepts only configured defaults; explicitly selected keys remain included.

TypeScript cannot distinguish structurally identical error classes. Use distinct instance fields or private brands when exact error-type checks are needed. Runtime mapping always matches constructors.

### Mapper methods

- `toHttpError(error)` accepts registered error types and preserves their HTTP status/message types. Use it in controllers for explicit handling.
- `toHttpErrorFromUnknown(error)` accepts any value and falls back to a generic 500.
- `toResponseSchemas(["module.error", ...])` generates schemas grouped by status, with mapped messages as literals and examples. Swagger display depends on your OpenAPI tooling.

## Thrown errors and custom handling

By default, thrown Awilixify `HttpException`s are sent with their status and response body. Other errors use the existing Fastify error handler, preserving validation errors and custom fallback behavior.

Set `handleHttpExceptions: false` if your application owns all thrown-error handling:

```ts
const HttpModule = FastifyModule({
  fastifyInstance,
  handleHttpExceptions: false,
});
```

Use `handler` for other request/response transformations:

```ts
FastifyModule({
  fastifyInstance,
  handler: async ({ invoke, reply }) => {
    const value = await invoke();
    if (reply.sent) return reply;
    return { data: value };
  },
});
```

## Hooks and route options

Awilixify `@before` hooks run as Fastify `preHandler` hooks. `@after` hooks run as `onSend` hooks and must use Fastify's signature. Ordering is class-before, method-before, handler, method-after, class-after.

Use native route config and constraints alongside HTTP decorators:

```ts
import { routeConfig, routeConstraints } from "@awilixify/fastify";

class SearchController {
  @GET("/search")
  @routeConfig({ rateLimit: { max: 20, timeWindow: "1 minute" } })
  @routeConstraints({ host: "api.example.com", version: "1.0.0" })
  search() {
    return [];
  }
}
```

Install and register any required plugins yourself, such as `@fastify/rate-limit` for the config above. Register custom constraint strategies before DI initialization. Version constraints use the `Accept-Version` header. Stacked config and constraint decorators shallow-merge their values.

## Shutdown

With the quick start's lifecycle provider, closing the context closes Fastify in `beforeShutdown()`, before DI resources are disposed:

```ts
await context.close();
```

If you manage the instance outside DI, call `fastifyInstance.close()` before `context.close()` instead.

## Development

```sh
npm install
npm run build:release
```
