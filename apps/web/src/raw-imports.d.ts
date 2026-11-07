// Vitest (Vite) loads files as strings with the ?raw suffix; used by tests only.
declare module "*?raw" {
  const content: string;
  export default content;
}
