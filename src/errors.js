export class AppError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function toPublicError(error) {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: {
        code: error.code,
        message: error.message,
        details: error.details || undefined
      }
    };
  }
  return {
    status: 500,
    body: {
      code: "INTERNAL_ERROR",
      message: "服务端处理失败，请稍后重试。"
    }
  };
}
