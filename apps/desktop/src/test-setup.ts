// Vitest global setup (component tests). `@testing-library/jest-dom` was already a dependency
// but unused/unwired until Faz 6 review fixes #15/#16/#17 needed real DOM-interaction tests.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
