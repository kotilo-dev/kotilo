import { describe, expect, it } from "vitest";
import {
  absolutePath,
  ancestorsOf,
  baseName,
  depthOf,
  isSameOrDescendant,
  joinRel,
  parentRel,
  pruneRecordPrefix,
  pruneSetPrefix,
  rekeyRecordPrefix,
  rekeySetPrefix,
} from "./paths";

describe("parentRel", () => {
  it("root'un ebeveyni kendisi (\"\")", () => {
    expect(parentRel("")).toBe("");
  });
  it("kök altındaki öğenin ebeveyni kök", () => {
    expect(parentRel("src")).toBe("");
  });
  it("iç içe yolun ebeveyni bir üst klasör", () => {
    expect(parentRel("src/app/App.tsx")).toBe("src/app");
  });
});

describe("baseName", () => {
  it("kök için boş döner", () => {
    expect(baseName("")).toBe("");
  });
  it("son bileşeni döner", () => {
    expect(baseName("src/app/App.tsx")).toBe("App.tsx");
    expect(baseName("src")).toBe("src");
  });
});

describe("joinRel", () => {
  it("kökte ad tek başına", () => {
    expect(joinRel("", "src")).toBe("src");
  });
  it("iç içe klasörde / ile birleşir", () => {
    expect(joinRel("src/app", "App.tsx")).toBe("src/app/App.tsx");
  });
});

describe("isSameOrDescendant", () => {
  it("kök her şeyin atası", () => {
    expect(isSameOrDescendant("a/b", "")).toBe(true);
  });
  it("kendisi de sayılır", () => {
    expect(isSameOrDescendant("a/b", "a/b")).toBe(true);
  });
  it("alt öğe true, kardeş false", () => {
    expect(isSameOrDescendant("a/b/c", "a/b")).toBe(true);
    expect(isSameOrDescendant("a/bc", "a/b")).toBe(false); // prefix ama farklı klasör
  });
});

describe("depthOf", () => {
  it("kök derinliği 0", () => {
    expect(depthOf("")).toBe(0);
  });
  it("iç içelik arttıkça derinlik artar", () => {
    expect(depthOf("src")).toBe(1);
    expect(depthOf("src/app")).toBe(2);
    expect(depthOf("src/app/App.tsx")).toBe(3);
  });
});

describe("absolutePath", () => {
  it("kök için ws.path'in kendisi", () => {
    expect(absolutePath({ path: "C:\\dev\\ctc" }, "")).toBe("C:\\dev\\ctc");
  });
  it("/ yerine Windows \\ kullanır", () => {
    expect(absolutePath({ path: "C:\\dev\\ctc" }, "src/app/App.tsx")).toBe("C:\\dev\\ctc\\src\\app\\App.tsx");
  });
});

describe("ancestorsOf", () => {
  it("kökün ataları boş dizi + kök", () => {
    expect(ancestorsOf("src")).toEqual([""]);
  });
  it("kökten derine sırayla döner", () => {
    expect(ancestorsOf("src/app/App.tsx")).toEqual(["", "src", "src/app"]);
  });
});

describe("rekeyRecordPrefix", () => {
  it("eşleşen anahtarları yeni önekle taşır, diğerlerini korur", () => {
    const rec = { "src/old": 1, "src/old/child": 2, "src/other": 3 };
    const next = rekeyRecordPrefix(rec, "src/old", "src/renamed");
    expect(next).toEqual({ "src/renamed": 1, "src/renamed/child": 2, "src/other": 3 });
  });
});

describe("pruneRecordPrefix", () => {
  it("eşleşen anahtarları çıkarır", () => {
    const rec = { "src/gone": 1, "src/gone/child": 2, "src/keep": 3 };
    const next = pruneRecordPrefix(rec, "src/gone");
    expect(next).toEqual({ "src/keep": 3 });
  });
});

describe("rekeySetPrefix / pruneSetPrefix", () => {
  it("Set için rekey", () => {
    const set = new Set(["src/old", "src/old/child", "src/other"]);
    const next = rekeySetPrefix(set, "src/old", "src/renamed");
    expect([...next].sort()).toEqual(["src/other", "src/renamed", "src/renamed/child"].sort());
  });
  it("Set için prune", () => {
    const set = new Set(["src/gone", "src/gone/child", "src/keep"]);
    const next = pruneSetPrefix(set, "src/gone");
    expect([...next]).toEqual(["src/keep"]);
  });
});
