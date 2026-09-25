package main

import "fmt"

func main() {
    result, err := someFunction()
    if err != nil {
        return err
    }
    
    for i := 0; i < 10; i++ {
        defer cleanup()
    }
}
