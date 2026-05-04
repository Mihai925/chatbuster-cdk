import { Stack } from 'aws-cdk-lib';
import { VpcConstruct } from './constructs/vpc-construct.js';
import { SecretsConstruct } from './constructs/secrets-construct.js';
import { DatabaseConstruct } from './constructs/database-construct.js';
import { CertificateConstruct } from './constructs/certificate-construct.js';
import { ComputeConstruct } from './constructs/compute-construct.js';
import { DeploymentConstruct } from './constructs/deployment-construct.js';

export class ChatBusterStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const { domainName } = props;

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
    new ComputeConstruct(this, 'Compute', {
      vpc: vpcConstruct.vpc,
      dbInstance: dbConstruct.instance,
      dbSecurityGroup: dbConstruct.securityGroup,
      secrets: secretsConstruct,
      certificate: certConstruct.certificate,
      deploymentBucket: deploymentConstruct.bucket,
      region: this.region,
    });
  }
}
