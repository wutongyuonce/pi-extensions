package main

import "fmt"

type Invoice struct {
	ID         string
	TotalCents int
}

func main() {
	invoices := []Invoice{{ID: "inv-001", TotalCents: 1250}, {ID: "inv-002", TotalCents: 3300}}
	fmt.Println(invoices)
}
