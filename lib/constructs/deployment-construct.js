import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { RemovalPolicy, CfnOutput } from 'aws-cdk-lib';

export class DeploymentConstruct extends Construct {
  bucket;

  constructor(scope, id, props) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'DeploymentBucket', {
      bucketName: `chatbuster-deployments-${props.account}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    new CfnOutput(this, 'DeploymentBucketName', {
      value: this.bucket.bucketName,
      description: 'S3 bucket for API deployment artifacts',
    });
  }
}
