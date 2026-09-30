import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./i18n";
// Paper look shared by the landing page and the app: Cutive display + Newsreader body (latin subsets, bundled).
import "@fontsource/cutive/latin-400.css";
import "@fontsource/newsreader/latin-400.css";
import "@fontsource/newsreader/latin-500.css";
import "@fontsource/newsreader/latin-400-italic.css";
import "./index.css";
import "./components/landing/landing.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
