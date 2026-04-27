variable "region" {
  type        = string
  description = "Region AWS dla Bedrock Custom Model Import. Wspierane: us-east-1, us-west-2."
  default     = "us-east-1"
}

variable "bucket_name" {
  type        = string
  description = "Nazwa S3 bucketa na wagi. Pusta = automatyczna nazwa bielik-bedrock-models-<account>-<region>."
  default     = ""
}
