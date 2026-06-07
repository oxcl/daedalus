export function unauthorizedResponse(message: string): Response {
  return new Response(
    JSON.stringify({
      error: { message, type: "invalid_request_error", code: null },
    }),
    {
      status: 401,
      headers: { "Content-Type": "application/json" },
    },
  );
}

export function authenticateRequest(
  request: Request,
  gatewayApiKey: string,
): Request | Response {
  const header = request.headers.get("Authorization");

  if (!header) {
    return unauthorizedResponse("Missing Authorization header");
  }

  if (header !== `Bearer ${gatewayApiKey}`) {
    return unauthorizedResponse("Invalid API key");
  }

  const stripped = new Request(request);
  stripped.headers.delete("Authorization");
  return stripped;
}
