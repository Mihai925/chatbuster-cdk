#!/bin/bash
set -e

exec > >(tee /var/log/user-data.log) 2>&1
echo "Starting user-data script at $(date)"

# Install dependencies
dnf install -y nodejs20 nodejs20-npm git jq

# Use Node 20 as default
alternatives --set node /usr/bin/node-20
export PATH="/usr/bin:$PATH"
node --version
npm --version

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
AUDIT_PASSWORD=$(aws secretsmanager get-secret-value --secret-id "__AUDIT_PASSWORD_SECRET_ARN__" --query SecretString --output text 2>/dev/null || echo "")
CREDENTIALS_ENCRYPTION_KEY=$(aws secretsmanager get-secret-value --secret-id "__CREDENTIALS_ENCRYPTION_KEY_SECRET_ARN__" --query SecretString --output text)
JWT_SECRET=$(aws secretsmanager get-secret-value --secret-id "__JWT_SECRET_ARN__" --query SecretString --output text)

# Stripe Managed Payments bundle is a JSON blob - fetch once, parse each field
# via jq. Empty strings are fine; the API treats checkout / billing-portal /
# webhook as unavailable until the operator pastes real values via AWS Console.
STRIPE_BUNDLE=$(aws secretsmanager get-secret-value --secret-id "__STRIPE_SECRET_ARN__" --query SecretString --output text)
STRIPE_SECRET_KEY_VALUE=$(echo "$STRIPE_BUNDLE" | jq -r '.secretKey // ""')
STRIPE_WEBHOOK_SECRET_VALUE=$(echo "$STRIPE_BUNDLE" | jq -r '.webhookSecret // ""')
STRIPE_PRICE_STARTER_MONTHLY_VALUE=$(echo "$STRIPE_BUNDLE" | jq -r '.priceStarterMonthly // ""')
STRIPE_PRICE_STARTER_ANNUAL_VALUE=$(echo "$STRIPE_BUNDLE" | jq -r '.priceStarterAnnual // ""')
STRIPE_PRICE_GROWTH_MONTHLY_VALUE=$(echo "$STRIPE_BUNDLE" | jq -r '.priceGrowthMonthly // ""')
STRIPE_PRICE_GROWTH_ANNUAL_VALUE=$(echo "$STRIPE_BUNDLE" | jq -r '.priceGrowthAnnual // ""')
STRIPE_PRICE_SCALE_MONTHLY_VALUE=$(echo "$STRIPE_BUNDLE" | jq -r '.priceScaleMonthly // ""')
STRIPE_PRICE_SCALE_ANNUAL_VALUE=$(echo "$STRIPE_BUNDLE" | jq -r '.priceScaleAnnual // ""')

RESEND_BUNDLE=$(aws secretsmanager get-secret-value --secret-id "__RESEND_SECRET_ARN__" --query SecretString --output text)
RESEND_API_KEY=$(echo "$RESEND_BUNDLE" | jq -r '.apiKey // ""')
EMAIL_FROM=$(echo "$RESEND_BUNDLE" | jq -r '.emailFrom // "ChatBuster <noreply@chatbuster.com>"')

# Create environment file
cat > /opt/chatbuster/.env << EOF
NODE_ENV=production
PORT=3001
DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}
ANTHROPIC_API_KEY=${ANTHROPIC_KEY}
SESSION_TOKEN_SECRET=${SESSION_SECRET}
AUDIT_PASSWORD=${AUDIT_PASSWORD}
CREDENTIALS_ENCRYPTION_KEY=${CREDENTIALS_ENCRYPTION_KEY}
JWT_SECRET=${JWT_SECRET}
STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY_VALUE}
STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET_VALUE}
STRIPE_PRICE_STARTER_MONTHLY=${STRIPE_PRICE_STARTER_MONTHLY_VALUE}
STRIPE_PRICE_STARTER_ANNUAL=${STRIPE_PRICE_STARTER_ANNUAL_VALUE}
STRIPE_PRICE_GROWTH_MONTHLY=${STRIPE_PRICE_GROWTH_MONTHLY_VALUE}
STRIPE_PRICE_GROWTH_ANNUAL=${STRIPE_PRICE_GROWTH_ANNUAL_VALUE}
STRIPE_PRICE_SCALE_MONTHLY=${STRIPE_PRICE_SCALE_MONTHLY_VALUE}
STRIPE_PRICE_SCALE_ANNUAL=${STRIPE_PRICE_SCALE_ANNUAL_VALUE}
PUBLIC_APP_URL=https://chatbuster.com
RESEND_API_KEY=${RESEND_API_KEY}
EMAIL_FROM=${EMAIL_FROM}
EOF

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
ExecStart=/usr/bin/node-20 dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable chatbuster

# Download and deploy application from S3
echo "Downloading application bundle from S3..."
if aws s3 cp s3://__DEPLOYMENT_BUCKET__/chatbuster-api/latest.tar.gz /tmp/app.tar.gz; then
  echo "Extracting application..."
  tar -xzf /tmp/app.tar.gz -C /opt/chatbuster
  chown -R chatbuster:chatbuster /opt/chatbuster

  echo "Installing production dependencies..."
  cd /opt/chatbuster
  sudo -u chatbuster npm ci --omit=dev

  echo "Pushing database schema..."
  sudo -u chatbuster npx prisma db push --schema=prisma/schema.postgresql.prisma --accept-data-loss

  echo "Starting ChatBuster service..."
  systemctl start chatbuster
  echo "Application deployed and started successfully!"
else
  echo "No app bundle found in S3 - infrastructure ready, waiting for first deployment"
fi

echo "User-data completed at $(date)"
