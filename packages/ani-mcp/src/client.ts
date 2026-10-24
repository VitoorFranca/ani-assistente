// A small client for the ANI-9 API, authenticated with a personal access
// token (Configurações → Integrações → Tokens de acesso in the ANI-9).

export type AniErrorKind = "auth" | "not_found" | "invalid" | "unavailable" | "unexpected";

/** An API failure with what an agent needs to decide: retry, ask the person, or give up. */
export class AniError extends Error {
  constructor(
    message: string,
    readonly kind: AniErrorKind,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AniError";
  }
}

export interface AniClientOptions {
  /** e.g. https://www.ani9.online */
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface AniClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
}

export function createAniClient(options: AniClientOptions): AniClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new AniError(
        timedOut ? "O ANI-9 demorou para responder." : "Não consegui falar com o ANI-9 (sem conexão?).",
        "unavailable",
        true,
      );
    }
    const text = await response.text();
    const data = text ? safeJson(text) : undefined;
    if (response.ok) return data as T;
    const message = (data as { error?: string } | undefined)?.error;
    if (response.status === 401 || response.status === 403) {
      throw new AniError(
        message ?? "O token do ANI-9 foi recusado. Gere outro em Configurações → Integrações.",
        "auth",
        false,
        response.status,
      );
    }
    if (response.status === 404) throw new AniError(message ?? "Não encontrado no ANI-9.", "not_found", false, 404);
    if (response.status === 400) throw new AniError(message ?? "O ANI-9 recusou o pedido.", "invalid", false, 400);
    if (response.status >= 500 || response.status === 429) {
      throw new AniError(
        "O ANI-9 está com problemas agora. Tente de novo em instantes.",
        "unavailable",
        true,
        response.status,
      );
    }
    throw new AniError(
      message ?? `Resposta inesperada do ANI-9 (${response.status}).`,
      "unexpected",
      false,
      response.status,
    );
  }

  return {
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body),
    patch: (path, body) => call("PATCH", path, body),
    put: (path, body) => call("PUT", path, body),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
