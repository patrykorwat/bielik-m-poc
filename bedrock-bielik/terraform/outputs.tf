output "bucket_name" {
  value       = aws_s3_bucket.model_weights.bucket
  description = "Nazwa bucketa na wagi modelu."
}

output "bucket_arn" {
  value       = aws_s3_bucket.model_weights.arn
  description = "ARN bucketa."
}

output "model_s3_uri" {
  value       = "s3://${aws_s3_bucket.model_weights.bucket}/${local.model_prefix}"
  description = "Pełny S3 URI gdzie maja trafić pliki modelu."
}

output "import_role_arn" {
  value       = aws_iam_role.bedrock_import.arn
  description = "ARN roli przekazywanej do create-model-import-job."
}

output "region" {
  value = var.region
}

output "proxy_aws_access_key_id" {
  value       = try(aws_iam_access_key.proxy[0].id, "")
  description = "AWS_ACCESS_KEY_ID dla zewnetrznego proxy"
  sensitive   = true
}

output "proxy_aws_secret_access_key" {
  value       = try(aws_iam_access_key.proxy[0].secret, "")
  description = "AWS_SECRET_ACCESS_KEY dla zewnetrznego proxy"
  sensitive   = true
}
