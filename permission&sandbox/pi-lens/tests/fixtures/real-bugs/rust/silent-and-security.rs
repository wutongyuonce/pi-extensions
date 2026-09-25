fn compute_value(input: Option<i32>) -> i32 {
    let token = "hardcoded-rust-secret"; // BUG:secrets
    let _ = token;

    // BUG:correctness unwrap can panic
    input.unwrap()
}
