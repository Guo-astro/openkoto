import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export class ApiError extends HTTPException {
  constructor(
    status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(status, { message });
  }
}

export const badRequest = (message: string, code = "BAD_REQUEST") => new ApiError(400, code, message);
export const unauthenticated = (message = "authentication required", code = "UNAUTHENTICATED") =>
  new ApiError(401, code, message);
export const forbidden = (message = "forbidden", code = "FORBIDDEN") => new ApiError(403, code, message);
export const notFound = (message = "not found") => new ApiError(404, "NOT_FOUND", message);
export const tooManyRequests = (retryAfter: number) =>
  new ApiError(429, "RATE_LIMITED", "too many requests", { "Retry-After": String(retryAfter) });

export function errorBody(code: string, message: string) {
  return { error: { code, message } };
}
