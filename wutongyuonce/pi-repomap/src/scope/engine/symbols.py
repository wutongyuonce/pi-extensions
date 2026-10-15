from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from scope.models import Symbol

_TS_PACK_AVAILABLE = False
_PARSERS: Dict[str, "Parser"] = {}

try:
    from tree_sitter import Language, Parser, Node  # type: ignore
    from tree_sitter_language_pack import get_language  # type: ignore
    _TS_PACK_AVAILABLE = True
except ImportError:
    pass

_EXT_TO_LANG = {
    ".py": "python",
    ".js": "javascript",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".go": "go",
    ".rs": "rust",
    ".rb": "ruby",
    ".java": "java",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".hpp": "cpp",
    ".hxx": "cpp",
    ".cs": "csharp",
    ".php": "php",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".swift": "swift",
    ".scala": "scala",
    ".sc": "scala",
    ".sh": "bash",
    ".bash": "bash",
    ".sql": "sql",
    ".lua": "lua",
    ".tf": "hcl",
    ".tfvars": "hcl",
    ".hcl": "hcl",
}

MAX_FILE_SIZE = 500_000

# ---- Visitor dispatch table ----
# Each handler receives (n, name, line, ext, parent_class, symbols) and returns
# True if it pushed a scope entry onto parent_class.
Handler = Callable[["Node", str, str, int, str, List[str], List[Tuple[str, str, int]]], bool]


def _make_handler(kind: str, scoped: bool = False, prefix: bool = False) -> Handler:
    """Factory: creates a simple handler that emits a symbol of `kind`.
    - scoped: pushes name onto parent_class so nested symbols get prefixed
    - prefix: prepends parent class name to the symbol name (e.g. `Class.method`)"""
    def _h(
        n: "Node", name: str, line: int, ext: str,
        parent_class: List[str], symbols: List[Tuple[str, str, int]],
    ) -> bool:
        full_name = f"{parent_class[-1]}.{name}" if prefix and parent_class else name
        symbols.append((kind, full_name, line))
        if scoped:
            parent_class.append(name)
        return scoped
    return _h


def _handle_function_def(
    n: "Node", name: str, line: int, ext: str,
    parent_class: List[str], symbols: List[Tuple[str, str, int]],
) -> bool:
    kind = "method" if parent_class else "function"
    full_name = f"{parent_class[-1]}.{name}" if parent_class else name
    symbols.append((kind, full_name, line))
    return False


def _handle_variable_declarator(
    n: "Node", name: str, line: int, ext: str,
    parent_class: List[str], symbols: List[Tuple[str, str, int]],
) -> bool:
    if ext not in (".js", ".ts", ".tsx"):
        return False
    value_node = n.child_by_field_name("value")
    if value_node is None:
        return False
    value_type = value_node.type
    full_name = f"{parent_class[-1]}.{name}" if parent_class else name
    if value_type in ("arrow_function", "function", "function_expression"):
        kind = "method" if parent_class else "function"
        symbols.append((kind, full_name, line))
    elif value_type in ("class", "class_expression"):
        symbols.append(("class", name, line))
    return False


def _handle_type_spec(
    n: "Node", name: str, line: int, ext: str,
    parent_class: List[str], symbols: List[Tuple[str, str, int]],
) -> bool:
    has_interface = any(c.type == "interface_type" for c in n.children)
    kind = "interface" if has_interface else "struct"
    symbols.append((kind, name, line))
    return False


# Line numbers are appended at the end; these are the per-node-type symbols
# without line numbers — the caller adds them.
_SCOPE_ENTERING: set[str] = {
    "class_definition", "class_declaration", "interface_declaration",
    "impl_item", "trait_item", "class_specifier",
}

# Map node type → handler. Handlers that don't need the full node are shared.
_HANDLERS: Dict[str, Handler] = {
    # Python
    "function_definition": _handle_function_def,
    "async_function_definition": _handle_function_def,
    "class_definition": _make_handler("class", scoped=True),
    # TypeScript / JavaScript
    "function_declaration": _handle_function_def,
    "class_declaration": _make_handler("class", scoped=True),
    "interface_declaration": _make_handler("interface", scoped=True),
    "method_definition": _make_handler("method", prefix=True),
    "method_declaration": _make_handler("method", prefix=True),
    "public_field_definition": _make_handler("method", prefix=True),
    "variable_declarator": _handle_variable_declarator,
    "type_alias_declaration": _make_handler("type"),
    "enum_declaration": _make_handler("enum"),
    # Go
    "type_spec": _handle_type_spec,
    # Rust
    "function_item": _handle_function_def,
    "struct_item": _make_handler("struct"),
    "trait_item": _make_handler("trait", scoped=True),
    "enum_item": _make_handler("enum"),
    # C / C++
    "struct_specifier": _make_handler("struct"),
    "class_specifier": _make_handler("class", scoped=True),
    # Ruby
    "class": _make_handler("class", scoped=True),
    "module": _make_handler("module", scoped=True),
    "method": _make_handler("method", prefix=True),
}

# ---- End dispatch table ----


def is_available() -> bool:
    return _TS_PACK_AVAILABLE


def get_parser(ext: str) -> "Parser | None":
    if not _TS_PACK_AVAILABLE:
        return None

    if ext in _PARSERS:
        return _PARSERS[ext]

    parser: "Parser | None" = None
    lang_name = _EXT_TO_LANG.get(ext)

    if lang_name:
        try:
            lang = get_language(lang_name)
            parser = Parser(lang)
        except Exception as e:
            print(f"[repo-baby] Could not load parser for {ext} ({lang_name}): {e}", file=sys.stderr)
            parser = None

    _PARSERS[ext] = parser
    return parser


def extract_symbols(file_path: str, repo_path: str) -> List[Symbol]:
    ext = Path(file_path).suffix
    full_path = os.path.join(repo_path, file_path)

    try:
        with open(full_path, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()
    except (OSError, IOError):
        return []

    if len(content) > MAX_FILE_SIZE:
        return []
    if len(content) > 10_000 and content.count("\n") < 10:
        return []

    parser = get_parser(ext)
    if parser is None:
        return []

    raw: List[Tuple[str, str, int]] = []
    try:
        tree = parser.parse(bytes(content, "utf-8"))
        raw = _walk_tree(tree.root_node, ext)
    except Exception as e:
        print(f"[repo-baby] tree-sitter error on {file_path}: {e}", file=sys.stderr)
        return []

    return [
        Symbol(name, kind, file_path, line)
        for kind, name, line in raw
        if not _is_dunder_base(name)
    ]


def _is_dunder_base(name: str) -> bool:
    base = name.rsplit(".", 1)[-1]
    return base.startswith("__") and base.endswith("__")


def _walk_tree(node: "Node", ext: str) -> List[Tuple[str, str, int]]:
    symbols: List[Tuple[str, str, int]] = []
    parent_class: List[str] = []
    _SCOPE_EXTRA = {("class", ".rb"), ("module", ".rb")}

    def visit(n: "Node", depth: int = 0):
        nonlocal parent_class
        if depth > 200 or n is None:
            return

        name_node = n.child_by_field_name("name")
        entered_scope = False

        if name_node is not None:
            name = name_node.text.decode("utf-8", errors="replace")
            line = name_node.start_point[0] + 1

            handler = _HANDLERS.get(n.type)
            if handler:
                entered_scope = handler(n, name, line, ext, parent_class, symbols)
            else:
                # Check Ruby scope types that depend on ext
                if (n.type, ext) in _SCOPE_EXTRA:
                    entered_scope = _push_ruby_scope(n, name, line, ext, parent_class, symbols)

        # HCL block handling (no name_node)
        if n.type == "block" and ext in (".tf", ".tfvars", ".hcl"):
            _handle_hcl_block(n, symbols)

        # Rust impl block (no name_node)
        if n.type == "impl_item" and ext == ".rs":
            _handle_rust_impl(n, parent_class, symbols)
            entered_scope = True

        # Detect scope entry for types not in handler dispatch
        if not entered_scope:
            _has_name = n.child_by_field_name("name") is not None
            entered_scope = (
                n.type in _SCOPE_ENTERING
                or ((n.type, ext) in _SCOPE_EXTRA and _has_name)
            )

        for child in n.children:
            visit(child, depth + 1)

        if entered_scope and parent_class:
            parent_class.pop()

    visit(node)
    return symbols


def _push_ruby_scope(
    n: "Node", name: str, line: int, ext: str,
    parent_class: List[str], symbols: List[Tuple[str, str, int]],
) -> bool:
    ntype = n.type
    if ntype == "class":
        symbols.append(("class", name, line))
    elif ntype == "module":
        symbols.append(("module", name, line))
    else:
        return False
    parent_class.append(name)
    return True


def _handle_hcl_block(
    n: "Node", symbols: List[Tuple[str, str, int]],
) -> None:
    children = n.children
    if len(children) < 1:
        return
    block_type = children[0].text.decode("utf-8", errors="replace")
    for child in children[1:]:
        if child.type in ("string_lit", "template_string"):
            raw = child.text.decode("utf-8", errors="replace")
            sym_name = raw.strip('"').strip("'")
            sym_line = child.start_point[0] + 1
            symbols.append((block_type, sym_name, sym_line))
            break


def _handle_rust_impl(
    n: "Node", parent_class: List[str], symbols: List[Tuple[str, str, int]],
) -> None:
    for child in n.children:
        if child.type == "type_identifier":
            impl_name = child.text.decode("utf-8", errors="replace")
            impl_line = child.start_point[0] + 1
            symbols.append(("impl", impl_name, impl_line))
            parent_class.append(impl_name)
            break
