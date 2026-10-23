export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', '无法连接服务器');
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : undefined;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? `请求失败（HTTP ${res.status}）`);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
