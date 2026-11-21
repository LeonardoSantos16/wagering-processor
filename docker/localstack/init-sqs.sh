#!/bin/bash
# Creates the SQS queues required by the case.
# wagering-events.fifo receives the integration events published from the outbox (ARCHITECTURE.md, section 13).
# Transient failures reach the DLQ through the redrive policy after 8 receives (ARCHITECTURE.md, section 12).
set -euo pipefail

awslocal sqs create-queue \
  --queue-name wagering-events.fifo \
  --attributes FifoQueue=true

DLQ_URL=$(awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true \
  --query QueueUrl --output text)

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"8\\\"}\"}"

echo "SQS queues created"
