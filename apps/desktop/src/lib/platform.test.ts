import { afterEach, describe, expect, it } from "vitest";
import { ROUTES, visibleRoutes } from "../app/routes";
import { platformFeatures, setPlatformForTests, webviewName } from "./platform";

describe("platform features (U-2)", () => {
  afterEach(() => setPlatformForTests("windows"));

  it("offers every feature and route on Windows", () => {
    expect(Object.values(platformFeatures()).every(Boolean)).toBe(true);
    expect(visibleRoutes()).toEqual(ROUTES);
  });

  it("drops the dictation route where dictation does not exist", () => {
    setPlatformForTests("linux", { dictation: false });
    expect(visibleRoutes().map((r) => r.id)).not.toContain("dictation");
    expect(visibleRoutes()).toHaveLength(ROUTES.length - 1);
  });

  it("names the system web view", () => {
    expect(webviewName("windows")).toBe("WebView2");
    expect(webviewName("linux")).toBe("WebKitGTK");
    expect(webviewName("macos")).toBe("WKWebView");
  });
});
