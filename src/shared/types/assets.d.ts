// Allow importing raw file contents (e.g. SQL migrations) as strings via Vite's `?raw`.
declare module '*.sql?raw' {
  const content: string;
  export default content;
}

declare module '*?raw' {
  const content: string;
  export default content;
}
