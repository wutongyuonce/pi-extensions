type Invoice = {
	id: string;
	totalCents: number;
};

const sampleInvoices: Invoice[] = [
	{ id: "inv-001", totalCents: 1250 },
	{ id: "inv-002", totalCents: 3300 },
];

export const demoTotal = sampleInvoices.reduce(
	(sum, invoice) => sum + invoice.totalCents,
	0,
);
