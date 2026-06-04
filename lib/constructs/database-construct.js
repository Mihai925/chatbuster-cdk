import { Construct } from 'constructs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';

export class DatabaseConstruct extends Construct {
  instance;
  securityGroup;

  constructor(scope, id, props) {
    super(scope, id);

    const { vpc } = props;

    this.securityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc,
      description: 'ChatBuster RDS Security Group',
      allowAllOutbound: false,
    });

    // SECTION 2 (100k-page tier) — HELD, deploy only when the first 100k-page
    // customer onboards. See plan: "Make the 100k-page tier survivable now,
    // scalable later". The Section 1 software changes (DB-backed scrape drainer,
    // decoupled batched embedding) already let a t3.micro single-AZ DB *survive*
    // 100k; these are the latency + HA upgrades worth their recurring cost only
    // once real revenue justifies them.
    //   - MICRO -> SMALL: 1 GiB -> 2 GiB RAM so the pgvector HNSW working set for
    //     a 100k-page store stays resident (search back to <50ms instead of
    //     spilling to the GP3 page cache). Step to MEDIUM (4 GiB) if memory
    //     pressure shows across all tenants.
    //   - multiAz true: a flagship customer on a single-AZ DB is a real
    //     AZ-outage risk. ~Doubles RDS hourly cost — the main recurring cost here.
    //   - maxAllocatedStorage: let storage autoscale past the fixed 20 GB so a
    //     large catalogue never needs a manual volume migration.
    this.instance = new rds.DatabaseInstance(this, 'PostgresInstance', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_15,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.SMALL
      ),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      securityGroups: [this.securityGroup],
      databaseName: 'chatbuster',
      credentials: rds.Credentials.fromGeneratedSecret('chatbuster_admin'),
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageType: rds.StorageType.GP3,
      multiAz: true,
      backupRetention: Duration.days(7),
      deleteAutomatedBackups: true,
      removalPolicy: RemovalPolicy.SNAPSHOT,
      deletionProtection: true,
    });
  }
}
