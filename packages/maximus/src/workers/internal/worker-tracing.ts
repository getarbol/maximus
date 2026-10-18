/**
 * Annotates the active Workers trace span with the service, the operation and the request id.
 */
import { tracing } from 'cloudflare:workers';

import { isRequestId } from '../../internal/correlation.ts';

/**
 * Call inside the invocation, after authenticating the native principal. Service
 * and operation are developer constants. Adds correlation to the existing native
 * span; does not mint/fake trace ids or enable exporters. No raw exception is
 * recorded on the native span.
 * Older workerd versions do not expose getActiveSpan. Annotation is best effort:
 * an unavailable or failing telemetry API must never change the business result.
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
