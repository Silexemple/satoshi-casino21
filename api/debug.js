import { json } from './_helpers.js';

export default async function handler(req) {
  const results = {};

  try {
    const { nwc } = await import('@getalby/sdk');
    results.import = 'OK';
    
    const client = new nwc.NWCClient({ nostrWalletConnectUrl: process.env.NWC_URL || 'not-set' });
    results.client = 'created';
    client.close();
  } catch(e) {
    results.error = e.message;
    results.stack = e.stack?.split('\n').slice(0,3).join(' | ');
  }

  results.nwc_url_set = !!process.env.NWC_URL;
  results.node_version = process.version;

  return json(200, results);
}
