/**
 * The pricing Worker as orders reaches it. vite.config.ts declares the Service Binding by the Worker's name,
 * which carries no types: the contract pricing publishes types it here, once.
 */
import type { PricingService } from '@maximus-examples/pricing/contract';

declare global {
  interface Env {
    /** Pricing's `Service` entrypoint, called as `orders`. */
    PRICING: Service<PricingService>;
  }
}
