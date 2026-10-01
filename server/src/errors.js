'use strict';

// 统一的领域错误类型，HTTP 适配层据此映射状态码
class DomainError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

const errors = {
  notFound: (msg, details) => new DomainError('NOT_FOUND', msg, details),
  conflict: (msg, details) => new DomainError('CONFLICT', msg, details),
  cycle: (msg, details) => new DomainError('CYCLE_DETECTED', msg, details),
  referenced: (msg, details) => new DomainError('REFERENCED', msg, details),
  forbidden: (msg, details) => new DomainError('FORBIDDEN', msg, details),
  invalid: (msg, details) => new DomainError('INVALID', msg, details),
};

module.exports = { DomainError, errors };
