// Hosted demo entry: start the in-browser network, then the normal web app.
import { startLocalNetwork } from './local-node.js';

window.FedrokLocal = await startLocalNetwork();
await import('../app.js');
