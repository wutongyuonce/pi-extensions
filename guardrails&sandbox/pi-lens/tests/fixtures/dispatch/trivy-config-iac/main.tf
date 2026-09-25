# Seeded misconfiguration fixture (#1757): a world-readable S3 bucket.
# `acl = "public-read"` with no public-access-block trips several of
# trivy's built-in AWS-00xx S3 checks (HIGH severity).
resource "aws_s3_bucket" "data" {
  bucket = "pi-lens-fixture-bucket"
}

resource "aws_s3_bucket_acl" "data_acl" {
  bucket = aws_s3_bucket.data.id
  acl    = "public-read"
}
