#!/bin/bash
set -e

exec > >(tee /var/log/user-data.log) 2>&1
echo "Starting user-data script at $(date)"

# Install dependencies
dnf install -y nodejs20 npm git jq

# Create app user
useradd -m -s /bin/bash chatbuster || true

# Create app directory
mkdir -p /opt/chatbuster
cd /opt/chatbuster

# TODO: Replace with your actual application repository or S3 artifact
# Option 1: Clone from GitHub (public repo or with deploy key)
# git clone https://github.com/YOUR_ORG/chatbuster-api.git .

# Option 2: Download from S3
# aws s3 cp s3://chatbuster-artifacts/chatbuster-api-latest.tar.gz . && tar -xzf chatbuster-api-latest.tar.gz

# For now, create a placeholder that will need to be replaced
echo "ERROR: Application source not configured. Update user-data.sh with your app source."

# Install dependencies
npm ci --production || npm install --production

# Build the application
npm run build || true

# Generate Prisma client
npm run db:generate || true

# Fetch secrets from AWS Secrets Manager
export AWS_REGION="__AWS_REGION__"

echo "Fetching database credentials..."
DB_SECRET=$(aws secretsmanager get-secret-value --secret-id "__DB_SECRET_ARN__" --query SecretString --output text)
DB_HOST=$(echo $DB_SECRET | jq -r '.host')
DB_PORT=$(echo $DB_SECRET | jq -r '.port')
DB_USER=$(echo $DB_SECRET | jq -r '.username')
DB_PASS=$(echo $DB_SECRET | jq -r '.password')
DB_NAME=$(echo $DB_SECRET | jq -r '.dbname')

echo "Fetching application secrets..."
ANTHROPIC_KEY=$(aws secretsmanager get-secret-value --secret-id "__ANTHROPIC_SECRET_ARN__" --query SecretString --output text 2>/dev/null || echo "")
SESSION_SECRET=$(aws secretsmanager get-secret-value --secret-id "__SESSION_SECRET_ARN__" --query SecretString --output text)

# Create environment file
cat > /opt/chatbuster/.env << EOF
NODE_ENV=production
PORT=3001
DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}
ANTHROPIC_API_KEY=${ANTHROPIC_KEY}
SESSION_TOKEN_SECRET=${SESSION_SECRET}
EOF

# Run Prisma migrations
cd /opt/chatbuster
npx prisma migrate deploy || echo "Migration failed or not available"

# Set ownership
chown -R chatbuster:chatbuster /opt/chatbuster

# Create systemd service
cat > /etc/systemd/system/chatbuster.service << EOF
[Unit]
Description=ChatBuster API
After=network.target

[Service]
Type=simple
User=chatbuster
WorkingDirectory=/opt/chatbuster
EnvironmentFile=/opt/chatbuster/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Start the service
systemctl daemon-reload
systemctl enable chatbuster
systemctl start chatbuster

# Wait for health check to pass
echo "Waiting for application to be healthy..."
for i in {1..30}; do
  if curl -sf http://localhost:3001/health/ready > /dev/null 2>&1; then
    echo "Application is healthy!"
    exit 0
  fi
  echo "Attempt $i: Not ready yet, waiting..."
  sleep 10
done

echo "Application failed to become healthy within timeout"
exit 1
