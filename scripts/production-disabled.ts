console.error("Production is already connected. This shortcut stays disabled to prevent accidental redeployment. For reviewed updates use explicit wrangler deploy --env production; see docs/PRODUCTION_OPERATIONS.md.");
process.exitCode = 1;
export {};
