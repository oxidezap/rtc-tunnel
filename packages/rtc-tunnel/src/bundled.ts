/**
 * Locates the wasm artifact bundled with this package.
 *
 * The package ships no wasm-bindgen glue and no runtime loader, because the
 * host decides how bytes reach `WebAssembly.instantiate`: fetch in a browser,
 * `readFile` in Node, direct bytes in tests. This only answers "where is it".
 */

/** File URL of the bundled `rtc_tunnel.wasm`. */
export function bundledWasmUrl(): URL {
  return new URL("../wasm/rtc_tunnel.wasm", import.meta.url);
}
