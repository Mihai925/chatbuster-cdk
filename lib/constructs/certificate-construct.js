import { Construct } from 'constructs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { CfnOutput } from 'aws-cdk-lib';

export class CertificateConstruct extends Construct {
  certificate;

  constructor(scope, id, props) {
    super(scope, id);

    const { domainName } = props;
    const apiDomain = `api.${domainName}`;

    this.certificate = new acm.Certificate(this, 'ApiCertificate', {
      domainName: apiDomain,
      validation: acm.CertificateValidation.fromDns(),
    });

    new CfnOutput(this, 'CertificateArn', {
      value: this.certificate.certificateArn,
      description: 'ACM Certificate ARN',
    });

    new CfnOutput(this, 'CertificateValidationInstructions', {
      value: `Add the CNAME record shown in AWS Console (ACM > Certificates) to Cloudflare DNS with proxy OFF`,
      description: 'Instructions for DNS validation',
    });
  }
}
