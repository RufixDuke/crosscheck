import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./index.css";
import App from "./App.tsx";
import { ScrollToTopOrHash } from "./components/ScrollToTopOrHash.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ScrollToTopOrHash />
      <App />
    </BrowserRouter>
  </StrictMode>,
);
