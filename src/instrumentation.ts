export async function register() {
  // Only show the banner on the Node.js server runtime (not edge).
  if (process.env.NEXT_RUNTIME === 'nodejs' || !process.env.NEXT_RUNTIME) {
    const { logStartupBanner } = await import('./lib/logger');
    logStartupBanner();
  }
}
