// Makes the fixture a real CUE module, the way clojure/deps.edn and
// gleam/gleam.toml do for theirs — without it cuelsp never resolves the
// package and the smoke passes vacuously.
module: "pi-lens.test/smoke"
language: version: "v0.9.0"
