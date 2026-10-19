#!/bin/sh
# Starts a throwaway RustFS on localhost:9000 and creates one bucket.
# Usage: start-rustfs.sh <access key> <secret key> <bucket>
set -eu
access_key=$1
secret_key=$2
bucket=$3

# The RustFS tag must match compose.yaml; Dependabot does not see this file.
docker run -d --name rustfs --network host \
  -e RUSTFS_ACCESS_KEY="$access_key" -e RUSTFS_SECRET_KEY="$secret_key" \
  rustfs/rustfs:1.0.3

# /health can answer before the S3 API does (a 503 on the first PUT), so
# retry the bucket create itself. 409 means it exists.
for attempt in $(seq 1 30); do
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT --aws-sigv4 aws:amz:us-east-1:s3 \
    --user "$access_key:$secret_key" "http://localhost:9000/$bucket" || true)
  if [ "$code" = 200 ] || [ "$code" = 409 ]; then exit 0; fi
  if [ "$attempt" = 30 ]; then echo "RustFS bucket create failed: $code"; exit 1; fi
  sleep 1
done
