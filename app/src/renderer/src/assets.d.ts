// Ambient asset modules — Vite's ?raw suffix returns file contents as a string.
declare module '*.svg?raw' {
  const src: string
  export default src
}

declare module '*.svg' {
  const src: string
  export default src
}
