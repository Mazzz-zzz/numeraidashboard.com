#!/usr/bin/env bash
# Build and push ML training container to ECR.
# Usage: ./build_and_push.sh [tag]
set -euo pipefail

AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
ECR_REPOSITORY="${ECR_REPOSITORY:-numerai-dashboard-ml-training}"
TAG="${1:-latest}"

: "${AWS_ACCOUNT_ID:?Set AWS_ACCOUNT_ID to the target AWS account ID}"
: "${AWS_REGION:?Set AWS_REGION or AWS_DEFAULT_REGION}"

REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
IMAGE="${REGISTRY}/${ECR_REPOSITORY}:${TAG}"

# Ensure ECR repo exists
aws ecr describe-repositories --repository-names "${ECR_REPOSITORY}" --region "${AWS_REGION}" 2>/dev/null || \
    aws ecr create-repository --repository-name "${ECR_REPOSITORY}" --region "${AWS_REGION}"

# Login to ECR
aws ecr get-login-password --region "${AWS_REGION}" | \
    docker login --username AWS --password-stdin "${REGISTRY}"

# Build from ml/ directory
cd "$(dirname "$0")/.."
docker build -t "${ECR_REPOSITORY}:${TAG}" -f sagemaker/Dockerfile .

# Tag and push
docker tag "${ECR_REPOSITORY}:${TAG}" "${IMAGE}"
docker push "${IMAGE}"

echo "Pushed: ${IMAGE}"
