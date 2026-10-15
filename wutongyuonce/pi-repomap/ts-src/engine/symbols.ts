import path from "node:path";
import { readFile } from "node:fs/promises";

import Parser, { type SyntaxNode } from "tree-sitter";
import Go from "tree-sitter-go";
import JavaScript from "tree-sitter-javascript";
import Python from "tree-sitter-python";
import Rust from "tree-sitter-rust";
import TypeScript from "tree-sitter-typescript";

import { createSymbol, type Symbol } from "../models.js";

type RawSymbol = [kind: string, name: string, line: number];
type Handler = (
  node: SyntaxNode,
  name: string,
  line: number,
  ext: string,
  parentClass: string[],
  symbols: RawSymbol[],
) => boolean;

type GrammarModule = Parameters<Parser["setLanguage"]>[0];

const MAX_FILE_SIZE = 500_000;
const parserCache = new Map<string, Parser>();
const scopeEntering = new Set([
  "class_definition",
  "class_declaration",
  "interface_declaration",
  "impl_item",
  "trait_item",
]);

const languageByExtension: Record<string, GrammarModule> = {
  ".py": Python,
  ".js": JavaScript,
  ".ts": TypeScript.typescript,
  ".tsx": TypeScript.tsx,
  ".go": Go,
  ".rs": Rust,
};

function makeHandler(kind: string, scoped = false, prefix = false): Handler {
  return (_node, name, line, _ext, parentClass, symbols) => {
    const fullName = prefix && parentClass.length > 0 ? `${parentClass.at(-1)}.${name}` : name;
    symbols.push([kind, fullName, line]);
    if (scoped) {
      parentClass.push(name);
    }
    return scoped;
  };
}

function handleFunctionDef(
  _node: SyntaxNode,
  name: string,
  line: number,
  _ext: string,
  parentClass: string[],
  symbols: RawSymbol[],
): boolean {
  const kind = parentClass.length > 0 ? "method" : "function";
  const fullName = parentClass.length > 0 ? `${parentClass.at(-1)}.${name}` : name;
  symbols.push([kind, fullName, line]);
  return false;
}

function handleVariableDeclarator(
  node: SyntaxNode,
  name: string,
  line: number,
  ext: string,
  parentClass: string[],
  symbols: RawSymbol[],
): boolean {
  if (![".js", ".ts", ".tsx"].includes(ext)) {
    return false;
  }
  const valueNode = node.childForFieldName("value");
  if (!valueNode) {
    return false;
  }

  const fullName = parentClass.length > 0 ? `${parentClass.at(-1)}.${name}` : name;
  if (["arrow_function", "function", "function_expression"].includes(valueNode.type)) {
    symbols.push([parentClass.length > 0 ? "method" : "function", fullName, line]);
  } else if (["class", "class_expression"].includes(valueNode.type)) {
    symbols.push(["class", name, line]);
  }
  return false;
}

function handleTypeSpec(
  node: SyntaxNode,
  name: string,
  line: number,
  _ext: string,
  _parentClass: string[],
  symbols: RawSymbol[],
): boolean {
  const hasInterface = node.children.some((child) => child.type === "interface_type");
  symbols.push([hasInterface ? "interface" : "struct", name, line]);
  return false;
}

const handlers = new Map<string, Handler>([
  ["function_definition", handleFunctionDef],
  ["async_function_definition", handleFunctionDef],
  ["class_definition", makeHandler("class", true)],
  ["function_declaration", handleFunctionDef],
  ["class_declaration", makeHandler("class", true)],
  ["interface_declaration", makeHandler("interface", true)],
  ["method_definition", makeHandler("method", false, true)],
  ["method_declaration", makeHandler("method", false, true)],
  ["public_field_definition", makeHandler("method", false, true)],
  ["variable_declarator", handleVariableDeclarator],
  ["type_alias_declaration", makeHandler("type")],
  ["enum_declaration", makeHandler("enum")],
  ["type_spec", handleTypeSpec],
  ["function_item", handleFunctionDef],
  ["struct_item", makeHandler("struct")],
  ["trait_item", makeHandler("trait", true)],
  ["enum_item", makeHandler("enum")],
]);

export function isAvailable(): boolean {
  return true;
}

export function supportedParserExtensions(): string[] {
  return Object.keys(languageByExtension).sort();
}

export function getParser(ext: string): Parser | null {
  const language = languageByExtension[ext];
  if (!language) {
    return null;
  }

  const cached = parserCache.get(ext);
  if (cached) {
    return cached;
  }

  const parser = new Parser();
  parser.setLanguage(language);
  parserCache.set(ext, parser);
  return parser;
}

export function extractSymbolsFromContent(filePath: string, content: string): Symbol[] {
  if (content.length > MAX_FILE_SIZE) {
    return [];
  }
  if (content.length > 10_000 && content.split("\n").length < 10) {
    return [];
  }

  const ext = path.extname(filePath);
  const parser = getParser(ext);
  if (!parser) {
    return [];
  }

  const tree = parser.parse(content);
  const rawSymbols = walkTree(tree.rootNode, ext);
  return rawSymbols
    .filter(([, name]) => !isDunderBase(name))
    .map(([kind, name, line]) => createSymbol({ name, kind, file: filePath, line }));
}

export async function extractSymbols(filePath: string, repoPath: string): Promise<Symbol[]> {
  try {
    const fullPath = path.join(repoPath, filePath);
    const content = await readFile(fullPath, "utf8");
    return extractSymbolsFromContent(filePath, content);
  } catch {
    return [];
  }
}

function isDunderBase(name: string): boolean {
  const base = name.includes(".") ? name.split(".").at(-1) ?? name : name;
  return base.startsWith("__") && base.endsWith("__");
}

function walkTree(rootNode: SyntaxNode, ext: string): RawSymbol[] {
  const symbols: RawSymbol[] = [];
  const parentClass: string[] = [];

  const visit = (node: SyntaxNode, depth = 0): void => {
    if (depth > 200) {
      return;
    }

    const nameNode = node.childForFieldName("name");
    let enteredScope = false;

    if (nameNode) {
      const name = nameNode.text;
      const line = nameNode.startPosition.row + 1;
      const handler = handlers.get(node.type);
      if (handler) {
        enteredScope = handler(node, name, line, ext, parentClass, symbols);
      }
    }

    if (node.type === "impl_item" && ext === ".rs") {
      enteredScope = handleRustImpl(node, parentClass, symbols) || enteredScope;
    }

    if (!enteredScope && scopeEntering.has(node.type) && nameNode) {
      parentClass.push(nameNode.text);
      enteredScope = true;
    }

    for (const child of node.children) {
      visit(child, depth + 1);
    }

    if (enteredScope && parentClass.length > 0) {
      parentClass.pop();
    }
  };

  visit(rootNode);
  return symbols;
}

function handleRustImpl(node: SyntaxNode, parentClass: string[], symbols: RawSymbol[]): boolean {
  const typeNode = node.children.find((child: SyntaxNode) => child.type === "type_identifier");
  if (!typeNode) {
    return false;
  }
  const implName = typeNode.text;
  const implLine = typeNode.startPosition.row + 1;
  symbols.push(["impl", implName, implLine]);
  parentClass.push(implName);
  return true;
}
