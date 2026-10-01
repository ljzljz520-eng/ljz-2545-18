'use strict';

/** 业务错误基类：携带 HTTP 状态码与结构化详情 */
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details || {};
  }
}

class NotFoundError extends ApiError {
  constructor(message = '资源不存在', details) {
    super(404, 'NOT_FOUND', message, details);
  }
}

class ValidationError extends ApiError {
  constructor(message = '请求参数不合法', details) {
    super(400, 'VALIDATION', message, details);
  }
}

/** 409：并发冲突（乐观锁）或 引用冲突（删除仍被引用的街区） */
class ConflictError extends ApiError {
  constructor(message, details) {
    super(409, 'CONFLICT', message, details);
  }
}

/** 409 的特化：版本冲突，响应中携带当前最新状态供客户端合并 */
class VersionConflictError extends ConflictError {
  constructor(message, current) {
    super(message, { current });
    this.code = 'VERSION_CONFLICT';
  }
}

/** 410：已撤回 —— 携带替代指向（fallback），让深链接有确定入口 */
class GoneError extends ApiError {
  constructor(message, details) {
    super(410, 'GONE', message, details);
  }
}

class ForbiddenError extends ApiError {
  constructor(message = '无权访问', details) {
    super(403, 'FORBIDDEN', message, details);
  }
}

module.exports = {
  ApiError,
  NotFoundError,
  ValidationError,
  ConflictError,
  VersionConflictError,
  GoneError,
  ForbiddenError,
};
