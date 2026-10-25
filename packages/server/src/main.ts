import { startServer } from './index.js';

startServer().catch((err) => {
  console.error('AgentFlow server failed to start:', err);
  process.exit(1);
});
