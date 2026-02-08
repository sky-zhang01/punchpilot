/// <reference types="vite/client" />

// CSS Modules type declarations
declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}
