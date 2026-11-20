import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { DomainError } from '../../../domain/errors/domain-error';
import { FailureCode } from '../../../domain/errors/failure-code';
import { HTTP_STATUS_BY_FAILURE_CODE } from './http-status';
import { RequestValidationError } from './request-validation.error';

export interface ErrorResponseBody {
  failureCode?: FailureCode;
  message: string;
  details?: unknown;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const [status, body] = this.toResponse(exception);
    this.adapterHost.httpAdapter.reply(host.switchToHttp().getResponse(), body, status);
  }

  private toResponse(exception: unknown): [number, ErrorResponseBody] {
    if (exception instanceof RequestValidationError) {
      return [400, { failureCode: exception.code, message: exception.message, details: exception.issues }];
    }
    if (exception instanceof DomainError) {
      return [
        HTTP_STATUS_BY_FAILURE_CODE[exception.code],
        { failureCode: exception.code, message: exception.message },
      ];
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return status === 400
        ? [400, { failureCode: FailureCode.InvalidPayload, message: exception.message }]
        : [status, { message: exception.message }];
    }
    this.logger.error(exception);
    return [500, { failureCode: FailureCode.ProcessingFailed, message: 'unexpected processing failure' }];
  }
}
