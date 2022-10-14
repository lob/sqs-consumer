class SQSError extends Error {
  code: string;
  statusCode: number;
  hostname: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

class TimeoutError extends Error {
  constructor(message = 'Operation timed out.') {
    super(message);
    this.message = message;
    this.name = 'TimeoutError';
  }
}

export {
  SQSError,
  TimeoutError
};
