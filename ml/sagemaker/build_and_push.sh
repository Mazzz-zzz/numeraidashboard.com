#!/usr/bin/env bash
# Build and push ML training container to ECR.
# Usage: ./build_and_push.sh [tag]
set -euo pipefail

ACCOUNT_ID="017915195458"
REGION="ap-southeast-2"
REPO="openoptions-ml-training"
TAG="${1:-latest}"
IMAGE="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${REPO}:${TAG}"

# Ensure ECR repo exists
aws ecr describe-repositories --repository-names "${REPO}" --region "${REGION}" 2>/dev/null || \
    aws ecr create-repository --repository-name "${REPO}" --region "${REGION}"

# Login to ECR
aws ecr get-login-password --region "${REGION}" | \
    docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

# Build from ml/ directory
cd "$(dirname "$0")/.."
docker build -t "${REPO}:${TAG}" -f sagemaker/Dockerfile .

# Tag and push
docker tag "${REPO}:${TAG}" "${IMAGE}"
docker push "${IMAGE}"

echo "Pushed: ${IMAGE}"
