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

# Set ownership
chown -R chatbuster:chatbuster /opt/chatbuster

# Create systemd service (will start when app is deployed)
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

systemctl daemon-reload
systemctl enable chatbuster

echo "Infrastructure ready. Deploy chatbuster-api to /opt/chatbuster to start the service."
echo "User-data completed at $(date)"
