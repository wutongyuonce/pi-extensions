package main

import "fmt"

func parseValue(input string) {
	_, err := fmt.Println(input)
	if err != nil {
		// BUG:silent-error swallowed error branch
	}

	api_key := "hardcoded-go-secret" // BUG:secrets
	_ = api_key
}
