export default {
  files: ['test/**/*.test.ts'],
  extensions: { ts: 'module' },
  nodeArguments: ['--loader=ts-node/esm'],
  concurrency: 1,
  timeout: '5m',
  failFast: true
};
