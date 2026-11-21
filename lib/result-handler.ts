import { isResultLike } from "awilixify";
import type { ErrorMapper, ErrorMappings } from "./error-mapper.js";
import type { FastifyHandler } from "./fastify.module.js";

/** Unwrap Results and send mapped error responses; leave plain responses unchanged. */
export function createResultHandler(
	errorMapper: Pick<ErrorMapper<ErrorMappings>, "toHttpErrorFromUnknown">,
): FastifyHandler {
	return async ({ invoke, reply }) => {
		const result = await invoke();

		if (reply.sent) return reply;
		if (!isResultLike(result)) return result;
		if (result.ok) return result.value;

		const error = errorMapper.toHttpErrorFromUnknown(result.error);

		return reply.code(error.statusCode).send(error.getResponse());
	};
}
