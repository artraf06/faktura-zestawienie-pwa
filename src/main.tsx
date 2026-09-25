import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
// Polyfill dla starszych przeglądarek (pdf.js używa Map.getOrInsertComputed)
for (const C of [Map, WeakMap] as unknown as { prototype: Record<string, unknown> }[]) {
  const P = C.prototype as Record<string, unknown> & { has(k: unknown): boolean; get(k: unknown): unknown; set(k: unknown, v: unknown): unknown };
  if (!P.getOrInsertComputed) P.getOrInsertComputed = function (this: typeof P, k: unknown, f: (k: unknown) => unknown) { if (!this.has(k)) this.set(k, f(k)); return this.get(k); };
  if (!P.getOrInsert) P.getOrInsert = function (this: typeof P, k: unknown, v: unknown) { if (!this.has(k)) this.set(k, v); return this.get(k); };
}


ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>
);
