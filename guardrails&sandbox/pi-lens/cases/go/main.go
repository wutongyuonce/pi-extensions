package main
import "fmt"
type User struct { ID string; Email string }
func main() { fmt.Println(User{ID: "u1", Email: "demo@example.com"}) }
