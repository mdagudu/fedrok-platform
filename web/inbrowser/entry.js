// Hosted demo entry: start the in-browser network, then the normal web app.
import { startLocalNetwork } from './local-node.js';

window.FedrokLocal = await startLocalNetwork({ snapshot: window.FEDROK_DEMO_SNAPSHOT || null });
await import('../app.js');
