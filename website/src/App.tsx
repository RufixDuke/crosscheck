import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { DocsLayout } from "./components/DocsLayout";
import { Home } from "./pages/Home";
import { Quickstart } from "./pages/Quickstart";
import { Commands } from "./pages/Commands";
import { Rules } from "./pages/Rules";
import { Config } from "./pages/Config";
import { Privacy } from "./pages/Privacy";
import { Faq } from "./pages/Faq";

function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route element={<DocsLayout />}>
          <Route path="quickstart" element={<Quickstart />} />
          <Route path="commands" element={<Commands />} />
          <Route path="rules" element={<Rules />} />
          <Route path="config" element={<Config />} />
          <Route path="privacy" element={<Privacy />} />
          <Route path="faq" element={<Faq />} />
        </Route>
      </Route>
    </Routes>
  );
}

export default App;
