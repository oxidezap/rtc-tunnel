/**
 * Low-level driver entry point.
 *
 * For hosts that implement `TunnelRuntime` themselves, and for the benchmark
 * harness. Normal callers use `@oxidezap/rtc-tunnel/node` or
 * `@oxidezap/rtc-tunnel/browser`, which set sensible defaults.
 */

export {
  createRelayTransportProvider,
  type AdvancedProviderOptions,
  type BackpressurePolicy,
  type ProviderOptions,
  type TunnelRuntime,
  type UdpEndpoint,
} from "./driver.ts";
