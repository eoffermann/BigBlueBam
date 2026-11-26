// bastion-api entry point. Prints a progress line FIRST, then loads the service: static ESM
// imports are evaluated before any statement in a module, so the env check, the stable-secret
// refusal and pool creation all happen inside the dynamic import below.
console.log(`[bastion-api] starting (pid ${process.pid}); validating configuration and connecting...`);

await import('./main.js');

export {};
