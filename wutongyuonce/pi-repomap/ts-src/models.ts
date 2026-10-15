export interface Symbol {
  name: string;
  kind: string;
  file: string;
  line: number;
  column: number;
  isExported: boolean;
  parent: string | null;
  signature: string | null;
  importance: number;
  refCount: number;
}

export interface FrameworkDetectionResult {
  frameworks: string[];
  entrypoints: string[];
  packageScripts: Record<string, string>;
}

export interface StatsData {
  sourceCandidates: number;
  scannedFiles: number;
  truncated: boolean;
  filesWithSymbols: number;
  symbols: number;
  languages: Record<string, number>;
  cacheHit: boolean;
}

export interface DependencyGraph {
  internalCounts: Record<string, number>;
  externalCounts: Record<string, number>;
}

export function createSymbol(input: Pick<Symbol, "name" | "kind" | "file" | "line"> & Partial<Symbol>): Symbol {
  return {
    name: input.name,
    kind: input.kind,
    file: input.file,
    line: input.line,
    column: input.column ?? 0,
    isExported: input.isExported ?? false,
    parent: input.parent ?? null,
    signature: input.signature ?? null,
    importance: input.importance ?? 0,
    refCount: input.refCount ?? 0,
  };
}

export function symbolToJSON(symbol: Symbol): Record<string, unknown> {
  return {
    name: symbol.name,
    kind: symbol.kind,
    file: symbol.file,
    line: symbol.line,
    column: symbol.column,
    is_exported: symbol.isExported,
    parent: symbol.parent,
    signature: symbol.signature,
    importance: symbol.importance,
    ref_count: symbol.refCount,
  };
}

export function symbolFromJSON(data: Record<string, unknown>): Symbol {
  return {
    name: String(data.name),
    kind: String(data.kind),
    file: String(data.file),
    line: Number(data.line ?? 0),
    column: Number(data.column ?? 0),
    isExported: Boolean(data.is_exported ?? data.isExported ?? false),
    parent: data.parent ? String(data.parent) : null,
    signature: data.signature ? String(data.signature) : null,
    importance: Number(data.importance ?? 0),
    refCount: Number(data.ref_count ?? data.refCount ?? 0),
  };
}
