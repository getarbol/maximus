/**
 * Annotates the active Workers trace span with the service, the operation and the request id.
 */
import { tracing } from 'cloudflare:workers';

import { isRequestId } from '../../internal/correlation.ts';

/**
 * Sets the service, the operation and, when it is a valid request id, the request id as attributes of the
 * active Workers trace span. Call it inside the invocation once the principal is verified, with constant
 * service and operation names. It starts no span, creates no trace id, enables no exporter and records no
 * error. A runtime without `tracing.getActiveSpan` is left alone, and a failing tracing API never changes the
 * result.
 */
export function annotateInvocation(
  service: string,
  operation: string,
  requestId: string,
  attributeNames = {
    service: 'service.name',
    operation: 'operation.name',
    requestId: 'request.id',
  }
): void {
  try {
    if (typeof tracing.getActiveSpan === 'function') {
      tracing.getActiveSpan()?.setAttributes({
        [attributeNames.service]: service,
        [attributeNames.operation]: operation,
        ...(isRequestId(requestId) ? { [attributeNames.requestId]: requestId } : {}),
      });
    }
  } catch {
    // Native tracing support can differ between deployed runtime versions.
  }
}
