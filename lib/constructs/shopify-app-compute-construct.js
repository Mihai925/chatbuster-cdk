import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Duration, CfnOutput } from 'aws-cdk-lib';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Shopify embedded app fleet. Shares the API's ALB via a host-based listener
 * rule (Host: app.chatbuster.com) and runs its own ASG on port 3000.
 *
 * Unlike ComputeConstruct, this fleet has no DB access — sessions persist via
 * HTTP calls to chatbuster-api over the public ALB (api.chatbuster.com).
 */
export class ShopifyAppComputeConstruct extends Construct {
  asg;
  targetGroup;

  constructor(scope, id, props) {
    super(scope, id);

    const {
      vpc,
      httpsListener,
      albSecurityGroup,
      certificate,
      deploymentBucket,
      adminSecret,
      shopifyApiSecret,
      hostName,
      shopifyApiKey,
      shopifyAppUrl,
      apiUrl,
      scopes,
      region,
    } = props;

    // Add app.chatbuster.com cert as a SAN on the existing 443 listener.
    httpsListener.addCertificates('AppCert', [certificate]);

    // EC2 Security Group — accepts traffic from the shared ALB on port 3000 only.
    const ec2Sg = new ec2.SecurityGroup(this, 'Ec2SecurityGroup', {
      vpc,
      description: 'ChatBuster Shopify App EC2 Security Group',
      allowAllOutbound: true,
    });
    ec2Sg.addIngressRule(albSecurityGroup, ec2.Port.tcp(3000), 'From ALB');

    // IAM role — same SSM access as API role, but DB and DB-secret are
    // intentionally absent. Only Shopify-app-relevant secrets are granted.
    const role = new iam.Role(this, 'Ec2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    adminSecret.grantRead(role);
    shopifyApiSecret.grantRead(role);
    deploymentBucket.grantRead(role);

    // Target group with /healthz health check on port 3000.
    this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.INSTANCE,
      healthCheck: {
        path: '/healthz',
        interval: Duration.seconds(30),
        timeout: Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        healthyHttpCodes: '200',
      },
      deregistrationDelay: Duration.seconds(30),
    });

    // Host-based listener rule: Host: app.chatbuster.com → this target group.
    new elbv2.ApplicationListenerRule(this, 'AppHostRule', {
      listener: httpsListener,
      priority: 10,
      conditions: [elbv2.ListenerCondition.hostHeaders([hostName])],
      action: elbv2.ListenerAction.forward([this.targetGroup]),
    });

    // Load user-data template and substitute placeholders.
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const userDataScript = fs.readFileSync(
      path.join(__dirname, '../../scripts/user-data-app.sh'),
      'utf8'
    );

    const finalScript = userDataScript
      .replace(/__ADMIN_SECRET_ARN__/g, adminSecret.secretArn)
      .replace(/__SHOPIFY_API_SECRET_ARN__/g, shopifyApiSecret.secretArn)
      .replace(/__DEPLOYMENT_BUCKET__/g, deploymentBucket.bucketName)
      .replace(/__AWS_REGION__/g, region)
      .replace(/__SHOPIFY_API_KEY__/g, shopifyApiKey)
      .replace(/__SHOPIFY_APP_URL__/g, shopifyAppUrl)
      .replace(/__CHATBUSTER_API_URL__/g, apiUrl)
      .replace(/__SCOPES__/g, scopes);

    const userData = ec2.UserData.forLinux();
    userData.addCommands(finalScript);

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

    this.targetGroup.addTarget(this.asg);

    this.asg.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      cooldown: Duration.minutes(5),
    });

    new CfnOutput(this, 'ShopifyAppAsgName', {
      value: this.asg.autoScalingGroupName,
      description: 'Auto Scaling Group name for the Shopify app — used by GitHub Actions Instance Refresh',
    });
  }
}
