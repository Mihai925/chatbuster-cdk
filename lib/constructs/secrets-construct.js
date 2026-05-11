import { Construct } from 'constructs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { CfnOutput } from 'aws-cdk-lib';

export class SecretsConstruct extends Construct {
  anthropicApiKeySecret;
  sessionTokenSecret;
  auditPasswordSecret;
  credentialsEncryptionKeySecret;

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

    new CfnOutput(this, 'AnthropicSecretArn', {
      value: this.anthropicApiKeySecret.secretArn,
      description: 'Set your Anthropic API key in this secret',
    });

    new CfnOutput(this, 'AuditPasswordSecretArn', {
      value: this.auditPasswordSecret.secretArn,
      description: 'Audit portal password (auto-generated, can be changed)',
    });
  }
}
