// Minimal typing for Vite's import.meta.glob, used by index.test.ts to read the engine sources as text.
interface ImportMeta {
  glob(pattern: string, options: { query: string; import: string; eager: true }): Record<string, string>;
}
