import { describe, expect, it } from "vitest";

import { extractSymbolsFromContent } from "../ts-src/engine/symbols.js";

describe("symbols", () => {
  it("extracts python classes and methods with scoped names", () => {
    const symbols = extractSymbolsFromContent(
      "service.py",
      [
        "class UserService:",
        "    def login(self):",
        "        return True",
        "",
        "def helper():",
        "    return 1",
      ].join("\n"),
    );

    expect(symbols.map((symbol) => `${symbol.kind}:${symbol.name}`)).toEqual([
      "class:UserService",
      "method:UserService.login",
      "function:helper",
    ]);
  });

  it("extracts ts variable declarator functions and classes", () => {
    const symbols = extractSymbolsFromContent(
      "app.ts",
      [
        "const helper = () => 1;",
        "const Box = class Box {};",
        "class Greeter {",
        "  greet() { return helper(); }",
        "}",
      ].join("\n"),
    );

    expect(symbols.map((symbol) => `${symbol.kind}:${symbol.name}`)).toContain("function:helper");
    expect(symbols.map((symbol) => `${symbol.kind}:${symbol.name}`)).toContain("class:Box");
    expect(symbols.map((symbol) => `${symbol.kind}:${symbol.name}`)).toContain("method:Greeter.greet");
  });

  it("extracts rust impl scopes as methods on impl type", () => {
    const symbols = extractSymbolsFromContent(
      "main.rs",
      [
        "struct User {}",
        "impl User {",
        "    fn create() -> Self { Self {} }",
        "}",
      ].join("\n"),
    );

    expect(symbols.map((symbol) => `${symbol.kind}:${symbol.name}`)).toContain("struct:User");
    expect(symbols.map((symbol) => `${symbol.kind}:${symbol.name}`)).toContain("impl:User");
    expect(symbols.map((symbol) => `${symbol.kind}:${symbol.name}`)).toContain("method:User.create");
  });
});
