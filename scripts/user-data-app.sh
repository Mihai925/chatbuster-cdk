#!/bin/bash
set -e

exec > >(tee /var/log/user-data.log) 2>&1
echo "Starting Shopify app user-data script at $(date)"

# Install dependencies
dnf install -y nodejs20 nodejs20-npm git jq

# Use Node 20 as default
alternatives --set node /usr/bin/node-20
export PATH="/usr/bin:$PATH"
node --version
npm --version

# Create app user
useradd -m -s /bin/bash chatbuster-app || true

# Create app directory
mkdir -p /opt/chatbuster-app
cd /opt/chatbuster-app

# Fetch secrets from AWS Secrets Manager
export AWS_REGION="__AWS_REGION__"

echo "Fetching Shopify API secret..."
SHOPIFY_API_SECRET=$(aws secretsmanager get-secret-value --secret-id "__SHOPIFY_API_SECRET_ARN__" --query SecretString --output text 2>/dev/null || echo "")

echo "Fetching admin secret..."
ADMIN_SECRET=$(aws secretsmanager get-secret-value --secret-id "__ADMIN_SECRET_ARN__" --query SecretString --output text)

# Create environment file
cat > /opt/chatbuster-app/.env << EOF
NODE_ENV=production
PORT=3000
SHOPIFY_API_KEY=__SHOPIFY_API_KEY__
SHOPIFY_API_SECRET=${SHOPIFY_API_SECRET}
SHOPIFY_APP_URL=__SHOPIFY_APP_URL__
SCOPES=__SCOPES__
CHATBUSTER_API_URL=__CHATBUSTER_API_URL__
CHATBUSTER_ADMIN_SECRET=${ADMIN_SECRET}
EOF

chown -R chatbuster-app:chatbuster-app /opt/chatbuster-app

# Create systemd service
cat > /etc/systemd/system/chatbuster-app.service << EOF
[Unit]
Description=ChatBuster Shopify App
After=network.target

[Service]
Type=simple
User=chatbuster-app
WorkingDirectory=/opt/chatbuster-app
EnvironmentFile=/opt/chatbuster-app/.env
ExecStart=/usr/bin/node-20 node_modules/.bin/react-router-serve build/server/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable chatbuster-app

# Download and deploy application from S3
echo "Downloading Shopify app bundle from S3..."
if aws s3 cp s3://__DEPLOYMENT_BUCKET__/chatbuster-app/latest.tar.gz /tmp/app.tar.gz; then
  echo "Extracting application..."
  tar -xzf /tmp/app.tar.gz -C /opt/chatbuster-app
  chown -R chatbuster-app:chatbuster-app /opt/chatbuster-app

  echo "Installing production dependencies..."
  cd /opt/chatbuster-app
  sudo -u chatbuster-app npm ci --omit=dev

  echo "Starting Shopify app service..."
  systemctl start chatbuster-app
  echo "Shopify app deployed and started successfully!"
else
  echo "No app bundle found in S3 - infrastructure ready, waiting for first deployment"
fi

echo "User-data completed at $(date)"
