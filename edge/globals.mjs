// Shared server modules use Node's Buffer. esbuild injects the import only at
// actual use sites; no browser or internal-server environment is modified.
export { Buffer } from "node:buffer";
