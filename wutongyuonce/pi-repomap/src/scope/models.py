from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List


@dataclass
class Symbol:
    name: str
    kind: str          # function, class, method, interface, struct, enum, etc.
    file: str          # relative path from repo root
    line: int          # 1-indexed
    column: int = 0
    is_exported: bool = False
    parent: str | None = None  # parent class/trait name if method
    signature: str | None = None

    # Populated by rank module
    importance: float = 0.0
    ref_count: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "kind": self.kind,
            "file": self.file,
            "line": self.line,
            "column": self.column,
            "is_exported": self.is_exported,
            "parent": self.parent,
            "signature": self.signature,
            "importance": self.importance,
            "ref_count": self.ref_count,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Symbol":
        return cls(
            name=str(data["name"]),
            kind=str(data["kind"]),
            file=str(data["file"]),
            line=int(data.get("line", 0)),
            column=int(data.get("column", 0)),
            is_exported=bool(data.get("is_exported", False)),
            parent=str(data["parent"]) if data.get("parent") else None,
            signature=str(data["signature"]) if data.get("signature") else None,
            importance=float(data.get("importance", 0.0)),
            ref_count=int(data.get("ref_count", 0)),
        )
