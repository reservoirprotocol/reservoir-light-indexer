import { SyncNode } from './SyncNode';
import { SyncNodeConfig } from './types';

const config: SyncNodeConfig = {
  syncer: {
    chain: 'mainnet',
    apiKey: process.env.API_KEY as string,
    mappings: [
      {
        datasets: ['asks'],
        table: 'asks',
        contracts: [],
      },
      {
        datasets: ['sales'],
        table: 'sales',
        contracts: [],
      },
    ],
  },
  server: {
    port: 1111,
    authorization: 'default',
  },
  logger: {
    datadog: {
      apiKey: 'xxxx-xxxx-xxxx',
      appName: 'sync-node',
    },
  },
};

export const node = new SyncNode(config);

node.launch();
