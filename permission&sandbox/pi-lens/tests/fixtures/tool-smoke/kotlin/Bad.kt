// Tool-smoke fixture for #209 — ktlint flags the missing spacing around `=`.
fun main() {
    val greeting="hello"
    println(greeting)
}

// LSP gate seed (#3217): kotlin-language-server flags the type mismatch.
val gateSeed: Int = "not a number"
