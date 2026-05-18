import { Stack, CfnOutput } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { VpcConstruct } from './constructs/vpc-construct.js';
import { SecretsConstruct } from './constructs/secrets-construct.js';
import { DatabaseConstruct } from './constructs/database-construct.js';
import { CertificateConstruct } from './constructs/certificate-construct.js';
import { ComputeConstruct } from './constructs/compute-construct.js';
import { ShopifyAppComputeConstruct } from './constructs/shopify-app-compute-construct.js';
import { DeploymentConstruct } from './constructs/deployment-construct.js';

// Public client_id from chatbuster-app/shopify.app.toml — not a secret.
const SHOPIFY_API_KEY = '28ebef0f66ad61cd135ee6dcf8dcfc82';
// Scopes from chatbuster-app/shopify.app.toml — comma-separated.
const SHOPIFY_SCOPES = 'read_content,read_orders,read_products,write_files';

export class ChatBusterStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const { domainName } = props;
    const apiHost = `api.${domainName}`;
    const appHost = `app.${domainName}`;

    // VPC
    const vpcConstruct = new VpcConstruct(this, 'Vpc');

    // Secrets
    const secretsConstruct = new SecretsConstruct(this, 'Secrets');

    // Deployment S3 bucket
    const deploymentConstruct = new DeploymentConstruct(this, 'Deployment', {
      account: this.account,
    });

    // Database
    const dbConstruct = new DatabaseConstruct(this, 'Database', {
      vpc: vpcConstruct.vpc,
    });

    // ACM Certificate (manual DNS validation in Cloudflare)
    const certConstruct = new CertificateConstruct(this, 'Certificate', {
      domainName,
    });

    // Compute (ALB + ASG)
    const computeConstruct = new ComputeConstruct(this, 'Compute', {
      vpc: vpcConstruct.vpc,
      dbInstance: dbConstruct.instance,
      dbSecurityGroup: dbConstruct.securityGroup,
      secrets: secretsConstruct,
      certificate: certConstruct.certificate,
      deploymentBucket: deploymentConstruct.bucket,
      region: this.region,
    });

    // ACM cert for app.chatbuster.com — added as a SAN to the existing 443
    // listener by ShopifyAppComputeConstruct. DNS validation in Cloudflare.
    const appCertificate = new acm.Certificate(this, 'AppCertificate', {
      domainName: appHost,
      validation: acm.CertificateValidation.fromDns(),
    });

    new CfnOutput(this, 'AppCertificateArn', {
      value: appCertificate.certificateArn,
      description: 'app.chatbuster.com ACM cert - add the validation CNAME shown in AWS Console to Cloudflare with proxy OFF',
    });

    // Shopify embedded app fleet — shares the existing ALB via a host-based
    // listener rule. No DB or DB-secret access; sessions persist via HTTP to
    // chatbuster-api.
    new ShopifyAppComputeConstruct(this, 'ShopifyAppCompute', {
      vpc: vpcConstruct.vpc,
      httpsListener: computeConstruct.httpsListener,
      albSecurityGroup: computeConstruct.albSecurityGroup,
      certificate: appCertificate,
      deploymentBucket: deploymentConstruct.bucket,
      adminSecret: secretsConstruct.adminSecret,
      shopifyApiSecret: secretsConstruct.shopifyApiSecret,
      hostName: appHost,
      shopifyApiKey: SHOPIFY_API_KEY,
      shopifyAppUrl: `https://${appHost}`,
      apiUrl: `https://${apiHost}`,
      scopes: SHOPIFY_SCOPES,
      region: this.region,
    });
  }
}
