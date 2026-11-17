/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" enables the dev-only mock API (src/api/mock.ts). Never set for production builds. */
  readonly VITE_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
