/**
 * Node and Bun entry point.
 *
 * Provides the wasm tunnel over a `node:dgram` socket. Importing this from a
 * browser build pulls in `node:dgram`, so the browser uses its own entry.
 */

import { createRelayTransportProvider, type AdvancedProviderOptions } from "./driver.ts";
import { createNodeRuntime, type NodeRuntimeOptions } from "./runtime/node.ts";
import { WasmTunnelModule, type WasmSource } from "./engine/wasm.ts";
import { bundledWasmUrl } from "./bundled.ts";
import type { RelayTransportProvider } from "./provider.ts";

export { createNodeRuntime } from "./runtime/node.ts";
export type { NodeRuntimeOptions } from "./runtime/node.ts";

export interface NodeProviderOptions extends AdvancedProviderOptions, NodeRuntimeOptions {
  /** Wasm artifact to load. Defaults to the artifact bundled with the package. */
  wasm?: WasmSource;
}

/**
 * A relay provider backed by the wasm tunnel over a Node or Bun UDP socket.
 *
 * Loads the wasm module once and reuses it across connections.
 */
export async function createNodeRelayProvider(
  options: NodeProviderOptions = {},
): Promise<RelayTransportProvider> {
  const source = options.wasm ?? (await readFile(bundledWasmUrl()));
  const module = await WasmTunnelModule.load(source);
  const runtime = createNodeRuntime((config) => module.createTunnel(config), options);
  return createRelayTransportProvider(runtime, options);
}

async function readFile(url: URL): Promise<Uint8Array> {
  const { readFile } = await import("node:fs/promises");
  return readFile(url);
}
