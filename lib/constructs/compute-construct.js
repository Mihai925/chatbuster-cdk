import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Duration, CfnOutput } from 'aws-cdk-lib';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

export class ComputeConstruct extends Construct {
  alb;
  asg;

  constructor(scope, id, props) {
    super(scope, id);

    const { vpc, dbInstance, dbSecurityGroup, secrets, certificate, deploymentBucket } = props;

    // ALB Security Group
    const albSg = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      description: 'ChatBuster ALB Security Group',
      allowAllOutbound: true,
    });
    albSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS from anywhere'
    );
    albSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'HTTP for redirect'
    );

    // EC2 Security Group
    const ec2Sg = new ec2.SecurityGroup(this, 'Ec2SecurityGroup', {
      vpc,
      description: 'ChatBuster EC2 Security Group',
      allowAllOutbound: true,
    });
    ec2Sg.addIngressRule(albSg, ec2.Port.tcp(3001), 'From ALB');

    // Allow EC2 to connect to RDS
    dbSecurityGroup.addIngressRule(ec2Sg, ec2.Port.tcp(5432), 'From EC2');

    // IAM Role for EC2
    const role = new iam.Role(this, 'Ec2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'AmazonSSMManagedInstanceCore'
        ),
      ],
    });

    // Allow reading secrets
    secrets.anthropicApiKeySecret.grantRead(role);
    secrets.sessionTokenSecret.grantRead(role);
    secrets.auditPasswordSecret.grantRead(role);
    secrets.credentialsEncryptionKeySecret.grantRead(role);
    secrets.jwtSecret.grantRead(role);
    dbInstance.secret.grantRead(role);

    // Allow reading from deployment bucket
    deploymentBucket.grantRead(role);

    // Application Load Balancer
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // Target Group with health check
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc,
      port: 3001,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.INSTANCE,
      healthCheck: {
        path: '/health/ready',
        interval: Duration.seconds(30),
        timeout: Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        healthyHttpCodes: '200',
      },
      deregistrationDelay: Duration.seconds(30),
    });

    // HTTPS Listener
    this.alb.addListener('HttpsListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
      defaultTargetGroups: [targetGroup],
    });

    // HTTP to HTTPS redirect
    this.alb.addListener('HttpListener', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        port: '443',
        protocol: 'HTTPS',
        permanent: true,
      }),
    });

    // Load user data script
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const userDataScript = fs.readFileSync(
      path.join(__dirname, '../../scripts/user-data.sh'),
      'utf8'
    );

    // Substitute placeholders
    const finalScript = userDataScript
      .replace(/__DB_SECRET_ARN__/g, dbInstance.secret.secretArn)
      .replace(/__ANTHROPIC_SECRET_ARN__/g, secrets.anthropicApiKeySecret.secretArn)
      .replace(/__SESSION_SECRET_ARN__/g, secrets.sessionTokenSecret.secretArn)
      .replace(/__AUDIT_PASSWORD_SECRET_ARN__/g, secrets.auditPasswordSecret.secretArn)
      .replace(/__CREDENTIALS_ENCRYPTION_KEY_SECRET_ARN__/g, secrets.credentialsEncryptionKeySecret.secretArn)
      .replace(/__JWT_SECRET_ARN__/g, secrets.jwtSecret.secretArn)
      .replace(/__DEPLOYMENT_BUCKET__/g, deploymentBucket.bucketName)
      .replace(/__AWS_REGION__/g, props.region);

    const userData = ec2.UserData.forLinux();
    userData.addCommands(finalScript);

    // Launch Template (required - Launch Configurations are deprecated)
    const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.SMALL
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      role,
      securityGroup: ec2Sg,
      userData,
      associatePublicIpAddress: true,
      requireImdsv2: true,
    });

    // Auto Scaling Group
    // Using ELB health check - instances must pass ALB /health/ready check
    this.asg = new autoscaling.AutoScalingGroup(this, 'Asg', {
      vpc,
      launchTemplate,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      minCapacity: 1,
      maxCapacity: 3,
      desiredCapacity: 1,
      healthCheck: autoscaling.HealthCheck.elb({
        grace: Duration.minutes(5),
      }),
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
        maxBatchSize: 1,
        minInstancesInService: 1,
        pauseTime: Duration.minutes(5),
      }),
    });

    // Register ASG with Target Group
    targetGroup.addTarget(this.asg);

    // CPU-based Auto Scaling
    this.asg.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      cooldown: Duration.minutes(5),
    });

    // Outputs
    new CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      description: 'ALB DNS Name - Add CNAME record in Cloudflare pointing api.chatbuster.com to this',
    });

    new CfnOutput(this, 'AsgName', {
      value: this.asg.autoScalingGroupName,
      description: 'Auto Scaling Group name for Instance Refresh',
    });
  }
}
