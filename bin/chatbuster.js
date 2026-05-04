#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { ChatBusterStack } from '../lib/chatbuster-stack.js';

const app = new App();

new ChatBusterStack(app, 'ChatBusterStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  domainName: 'chatbuster.com',
});

app.synth();
