import { nwc } from '@getalby/sdk';

const NWC_URL = 'nostr+walletconnect://ec096afe047a692500865c569f3391996c4434d613a562c27259c9845f7bf532?relay=wss://relay.getalby.com&relay=wss://relay2.getalby.com&secret=9e3d244766f8134ed5bc2f91815535104ddd5a4d2f97516b76bf8bbacc2ff546&lud16=silexperience@getalby.com';

console.log('Connecting...');
const client = new nwc.NWCClient({ nostrWalletConnectUrl: NWC_URL });

try {
  const info = await client.getInfo();
  console.log('Methods supported:', info.methods);
  
  const invoice = await client.makeInvoice({ amount: 1000, description: 'test' });
  console.log('Invoice OK:', invoice.payment_hash);
} catch(e) {
  console.error('Error:', e.message, e.code);
} finally {
  client.close();
}
