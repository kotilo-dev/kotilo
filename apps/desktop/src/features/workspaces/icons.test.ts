import { describe, expect, it } from "vitest";
import { extensionOf, iconFor } from "./icons";

describe("extensionOf", () => {
  it("normal uzantı", () => {
    expect(extensionOf("App.tsx")).toBe("tsx");
  });
  it("büyük harfli uzantı küçültülür", () => {
    expect(extensionOf("README.MD")).toBe("md");
  });
  it("uzantısız dosya null", () => {
    expect(extensionOf("Makefile")).toBeNull();
  });
  it("nokta ile başlayan gizli dosya (uzantısı yok sayılır)", () => {
    expect(extensionOf(".gitignore")).toBeNull();
  });
  it("çoklu nokta: son uzantı alınır", () => {
    expect(extensionOf("archive.tar.gz")).toBe("gz");
  });
});

describe("iconFor", () => {
  it("klasör kapalıyken kapalı ikon", () => {
    expect(iconFor("src", true, false)).toBe("📁");
  });
  it("klasör açıkken açık ikon", () => {
    expect(iconFor("src", true, true)).toBe("📂");
  });
  it("bilinen uzantı eşlenir", () => {
    expect(iconFor("App.tsx", false)).toBe("🟦");
    expect(iconFor("styles.css", false)).toBe("🎨");
    expect(iconFor("photo.PNG", false)).toBe("🖼️");
  });
  it("bilinmeyen/uzantısız dosya varsayılan ikon", () => {
    expect(iconFor("Makefile", false)).toBe("📄");
    expect(iconFor("data.unknownext", false)).toBe("📄");
  });
});
