export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, 'bad_request', message);
export const unauthorized = (message = '未登录或会话已过期') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = '没有权限') => new HttpError(403, 'forbidden', message);
export const notFound = (message = '不存在') => new HttpError(404, 'not_found', message);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);
