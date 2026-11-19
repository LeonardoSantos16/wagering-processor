#!/bin/bash
# Creates the SQS queues required by the case.
# Redrive policy (maxReceiveCount) is configured later, together with the retry/DLQ design.
set -euo pipefail

awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes FifoQueue=true

echo "SQS queues created"
