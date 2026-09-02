# Tool-smoke fixture (#1937) — terragrunt flags the undefined local reference.
terraform {
  source = local.undefined_source
}
