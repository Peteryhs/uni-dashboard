/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional device bearer token, matching RELAY_TOKEN on the relay. */
  readonly VITE_RELAY_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
