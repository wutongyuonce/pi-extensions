# Tool-smoke fixture for #3311 — terraform-ls reports the undeclared variable.
output "greeting" {
  value = var.does_not_exist_gate_seed
}
