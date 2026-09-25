import os

sample_invoices = [
    {"id": "inv-001", "total_cents": 1250},
    {"id": "inv-002", "total_cents": 3300},
]


def build_total() -> str:
    return str(sum(invoice["total_cents"] for invoice in sample_invoices))


demo_total = build_total()
