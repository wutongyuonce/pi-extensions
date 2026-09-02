from typing import TypedDict


class Invoice(TypedDict):
    id: str
    total_cents: int


sample_invoices: list[Invoice] = [
    {"id": "inv-001", "total_cents": 1250},
    {"id": "inv-002", "total_cents": 3300},
]


demo_total: str = str(sum(invoice["total_cents"] for invoice in sample_invoices))
