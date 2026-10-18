/**
 * The orders Worker's bindings: the pricing Service Binding and the development token.
 */
import type { PricingService } from '../../pricing/src/index';

/** The bindings declared in orders/cloudflare.config.ts, plus the local-only development token. */
export interface Env {
  /** Native RPC to the pricing Worker; the binding's props name this deployment as `orders`. */
  PRICING: Service<typeof PricingService>;
  DEVELOPMENT_TOKEN?: string;
}
