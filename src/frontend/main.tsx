import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import App from "./App";
import BrowsePage from "./pages/BrowsePage";
import DocsPage from "./pages/DocsPage";
import RubricPage from "./pages/RubricPage";
import SubmitPage from "./pages/SubmitPage";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route index element={<BrowsePage />} />
          <Route path="rubric" element={<RubricPage />} />
          <Route path="docs" element={<DocsPage />} />
          <Route path="submit" element={<SubmitPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>
);
