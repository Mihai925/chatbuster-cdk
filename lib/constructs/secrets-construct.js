import { Construct } from 'constructs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { CfnOutput } from 'aws-cdk-lib';

export class SecretsConstruct extends Construct {
  anthropicApiKeySecret;
  sessionTokenSecret;
  auditPasswordSecret;
  credentialsEncryptionKeySecret;
  jwtSecret;
  lemonSqueezySecret;
  resendSecret;

  constructor(scope, id, props = {}) {
    super(scope, id);

    // Anthropic API Key - must be set manually after deployment
    this.anthropicApiKeySecret = new secretsmanager.Secret(
      this,
      'AnthropicApiKey',
      {
        secretName: 'chatbuster/anthropic-api-key',
        description: 'Anthropic API key for ChatBuster - set value manually',
      }
    );

    // Session Token Secret - auto-generated
    this.sessionTokenSecret = new secretsmanager.Secret(
      this,
      'SessionTokenSecret',
      {
        secretName: 'chatbuster/session-token-secret',
        description: 'Session token signing secret for ChatBuster',
        generateSecretString: {
          passwordLength: 32,
          excludePunctuation: true,
        },
      }
    );

    // Audit Portal Password - auto-generated, can be changed manually
    this.auditPasswordSecret = new secretsmanager.Secret(
      this,
      'AuditPasswordSecret',
      {
        secretName: 'chatbuster/audit-password',
        description: 'Password for audit portal access',
        generateSecretString: {
          passwordLength: 32,
          excludePunctuation: true,
        },
      }
    );

    // JWT secret for user-auth tokens (/auth/* endpoints) - auto-generated. The
    // API rejects values <32 chars, and excludePunctuation gives us 32 alphanums.
    // NOTE: rotating this invalidates all outstanding user sessions — everyone
    // gets logged out and has to re-authenticate.
    this.jwtSecret = new secretsmanager.Secret(this, 'JwtSecret', {
      secretName: 'chatbuster/jwt-secret',
      description: 'HMAC-SHA256 signing secret for user auth JWTs',
      generateSecretString: {
        passwordLength: 32,
        excludePunctuation: true,
      },
    });

    // Credentials encryption key - auto-generated. Used by the API to encrypt
    // stored WooCommerce API creds and Shopify access tokens at rest.
    // NOTE: changing or losing this makes those stored secrets unrecoverable —
    // the WooCommerce plugin must re-provision (toggle order tracking off/on),
    // Shopify re-sends its token automatically.
    this.credentialsEncryptionKeySecret = new secretsmanager.Secret(
      this,
      'CredentialsEncryptionKeySecret',
      {
        secretName: 'chatbuster/credentials-encryption-key',
        description: 'AES key material for encrypting stored credentials at rest',
        generateSecretString: {
          passwordLength: 32,
          excludePunctuation: true,
        },
      }
    );

    // LemonSqueezy bundle - single JSON secret. The `webhookSecret` field is
    // auto-generated on first deploy; the rest are blanks the operator fills in
    // via AWS Console after creating products in the LS dashboard. user-data.sh
    // parses this JSON with jq and writes each field as a separate env var.
    //
    // After the first cdk deploy:
    //   1. AWS Console -> Secrets Manager -> chatbuster/lemonsqueezy
    //   2. Retrieve secret value -> Edit -> paste:
    //        - apiKey            (LS dashboard -> Settings -> API)
    //        - storeId           (numeric, visible in the LS store URL)
    //        - variantStarter, variantGrowth, variantScale (from each product's
    //          Variants tab)
    //        - variantStarterAnnual / Growth / Scale (optional; if omitted the
    //          monthly variant is reused)
    //   3. Copy the auto-generated `webhookSecret` value and paste it into
    //      LS dashboard -> Settings -> Webhooks when registering the endpoint
    //      https://api.chatbuster.com/webhooks/lemonsqueezy
    this.lemonSqueezySecret = new secretsmanager.Secret(this, 'LemonSqueezySecret', {
      secretName: 'chatbuster/lemonsqueezy',
      description: 'LemonSqueezy API key, store ID, variant IDs, and webhook secret (JSON)',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          apiKey: '',
          storeId: '',
          variantStarter: '',
          variantGrowth: '',
          variantScale: '',
          variantStarterAnnual: '',
          variantGrowthAnnual: '',
          variantScaleAnnual: '',
        }),
        generateStringKey: 'webhookSecret',
        passwordLength: 32,
        excludePunctuation: true,
      },
    });

    // Resend (transactional email - password reset, welcome). JSON bundle so
    // the operator can also override the From address without a code change.
    //
    // After first cdk deploy, fill in via AWS Console:
    //   - apiKey   (Resend dashboard -> API Keys -> create one with "Sending access")
    //   - emailFrom defaults to "ChatBuster <noreply@chatbuster.com>" — only
    //     change it if the verified sender domain in Resend differs.
    //
    // DNS prerequisite: add DKIM + SPF records to chatbuster.com (Resend
    // dashboard -> Domains -> Add domain prints the records). The API won't
    // send mail until the sender domain shows "Verified" in Resend.
    this.resendSecret = new secretsmanager.Secret(this, 'ResendSecret', {
      secretName: 'chatbuster/resend',
      description: 'Resend API key + From address for transactional email (JSON)',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          apiKey: '',
          emailFrom: 'ChatBuster <noreply@chatbuster.com>',
        }),
        // No auto-generated field, but generateStringKey is required by the
        // CloudFormation property — point it at a throwaway key we ignore.
        generateStringKey: '_unused',
        passwordLength: 16,
        excludePunctuation: true,
      },
    });

    new CfnOutput(this, 'ResendSecretArn', {
      value: this.resendSecret.secretArn,
      description: 'Resend bundle - paste API key via AWS Console after deploy + verify sender domain in Resend',
    });

    new CfnOutput(this, 'AnthropicSecretArn', {
      value: this.anthropicApiKeySecret.secretArn,
      description: 'Set your Anthropic API key in this secret',
    });

    new CfnOutput(this, 'AuditPasswordSecretArn', {
      value: this.auditPasswordSecret.secretArn,
      description: 'Audit portal password (auto-generated, can be changed)',
    });

    new CfnOutput(this, 'LemonSqueezySecretArn', {
      value: this.lemonSqueezySecret.secretArn,
      description: 'LemonSqueezy bundle - paste apiKey/storeId/variantIDs via AWS Console after deploy',
    });
  }
}
