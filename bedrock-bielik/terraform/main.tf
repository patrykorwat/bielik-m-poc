terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}

provider "aws" {
  region = var.region
}

data "aws_caller_identity" "current" {}

locals {
  account_id   = data.aws_caller_identity.current.account_id
  bucket_name  = var.bucket_name != "" ? var.bucket_name : "bielik-bedrock-models-${local.account_id}-${var.region}"
  model_prefix = "bielik-11b-v3.0-instruct/"
}

# S3 bucket trzyma wagi modelu. Bedrock CMI czyta stąd przy imporcie.
resource "aws_s3_bucket" "model_weights" {
  bucket        = local.bucket_name
  force_destroy = false

  tags = {
    Project = "bielik-bedrock"
    Model   = "Bielik-11B-v3.0-Instruct"
  }
}

resource "aws_s3_bucket_versioning" "model_weights" {
  bucket = aws_s3_bucket.model_weights.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "model_weights" {
  bucket = aws_s3_bucket.model_weights.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "model_weights" {
  bucket                  = aws_s3_bucket.model_weights.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# IAM role którą przyjmuje usługa Bedrock przy imporcie modelu.
data "aws_iam_policy_document" "bedrock_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["bedrock.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = ["arn:aws:bedrock:${var.region}:${local.account_id}:model-import-job/*"]
    }
  }
}

data "aws_iam_policy_document" "s3_read" {
  statement {
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:ListBucket"
    ]
    resources = [
      aws_s3_bucket.model_weights.arn,
      "${aws_s3_bucket.model_weights.arn}/*"
    ]
  }
}

resource "aws_iam_role" "bedrock_import" {
  name               = "BedrockBielikImportRole"
  assume_role_policy = data.aws_iam_policy_document.bedrock_assume.json
}

resource "aws_iam_role_policy" "bedrock_s3" {
  name   = "BedrockBielikS3Read"
  role   = aws_iam_role.bedrock_import.id
  policy = data.aws_iam_policy_document.s3_read.json
}

# IAM user pod proxy uruchomione poza AWS (np. Lightsail Frankfurt).
# Wystawiamy access key/secret key, pakujemy do env zmiennych proxy.
# Polityka pozwala wylacznie na invoke importowanego modelu.
variable "create_proxy_iam_user" {
  type        = bool
  description = "Tworzyc IAM usera dla zewnetrznego proxy (Lightsail itp.)"
  default     = true
}

variable "imported_model_arn" {
  type        = string
  description = "ARN zaimportowanego modelu w Bedrock (z .imported_model_arn po imporcie)"
  default     = ""
}

resource "aws_iam_user" "proxy" {
  count = var.create_proxy_iam_user ? 1 : 0
  name  = "BielikBedrockProxy"
  tags  = { Project = "bielik-bedrock" }
}

data "aws_iam_policy_document" "proxy_invoke" {
  statement {
    effect  = "Allow"
    actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
    resources = var.imported_model_arn != "" ? [var.imported_model_arn] : [
      "arn:aws:bedrock:${var.region}:${local.account_id}:imported-model/*"
    ]
  }
}

resource "aws_iam_user_policy" "proxy_invoke" {
  count  = var.create_proxy_iam_user ? 1 : 0
  name   = "BielikBedrockInvoke"
  user   = aws_iam_user.proxy[0].name
  policy = data.aws_iam_policy_document.proxy_invoke.json
}

resource "aws_iam_access_key" "proxy" {
  count = var.create_proxy_iam_user ? 1 : 0
  user  = aws_iam_user.proxy[0].name
}
