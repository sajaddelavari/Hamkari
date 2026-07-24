export class AppError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export function badRequest(code, message, fields) {
  return new AppError(400, code, message, fields);
}

export function unauthorized(message = 'برای ادامه وارد حساب مدیر شوید.') {
  return new AppError(401, 'UNAUTHENTICATED', message);
}

export function forbidden(code = 'FORBIDDEN', message = 'اجازه انجام این عملیات را ندارید.') {
  return new AppError(403, code, message);
}

export function notFound(code, message) {
  return new AppError(404, code, message);
}

export function conflict(code, message, fields) {
  return new AppError(409, code, message, fields);
}

