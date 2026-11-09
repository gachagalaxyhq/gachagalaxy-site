// Monthly: republish every Gacha Mark on the testnet registry with its current onchain fields, so each stays valid 30 more days.
// Revoked Marks (src/revoked.json) are skipped so they expire. Fails closed if the revocation list is unreadable.
// Needs secrets TESTNET_BOT_KEYSTORE (JSON) and TESTNET_BOT_PASSPHRASE. Testnet only.
import fs from 'fs';

export function loadRevoked(text) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.revoked)) throw new Error('src/revoked.json: "revoked" must be an array');
  const set = new Set();
  for (const r of data.revoked) {
    if (!r || typeof r.grader !== 'string' || typeof r.cert !== 'string' || !/^\d{6,13}$/.test(r.cert.trim()))
      throw new Error('src/revoked.json: each entry needs grader and a numeric cert');
    set.add(r.grader.trim().toUpperCase() + ':' + r.cert.trim());
  }
  return set;
}

export function plan(certs, revoked, grader = 'PSA') {
  const publish = [], skipped = [];
  for (const cert of certs) (revoked.has(grader + ':' + cert) ? skipped : publish).push(cert);
  return { publish, skipped };
}

async function main() {
  const { ethers } = await import('ethers');
  const oc = JSON.parse(fs.readFileSync(new URL('../src/onchain.json', import.meta.url)));
  const revoked = loadRevoked(fs.readFileSync(new URL('../src/revoked.json', import.meta.url), 'utf8'));
  const { publish, skipped } = plan(Object.keys(oc.events), revoked);
  for (const cert of skipped) console.log('skipped (revoked)', cert);
  const p = new ethers.JsonRpcProvider('https://rpc.testnet.chain.robinhood.com');
  const bot = (await ethers.Wallet.fromEncryptedJson(process.env.TESTNET_BOT_KEYSTORE, process.env.TESTNET_BOT_PASSPHRASE)).connect(p);
  const abi = ['function getAppraisalByCert(string,string) view returns (tuple(uint64 fmvLow,uint64 fmvPoint,uint64 fmvHigh,uint16 ltvBps,uint16 confidenceScore,uint16 compCount,uint8 confidence,uint8 risk,bool eligible,uint40 appraisedAt,address attester))',
    'function publish(string,string,uint64,uint64,uint64,uint16,uint16,uint16,uint8,uint8,bool) returns (bytes32)'];
  const reg = new ethers.Contract(oc.registry, abi, bot);
  console.log('bot', bot.address, 'balance', ethers.formatEther(await p.getBalance(bot.address)));
  for (const cert of publish) {
    const a = await reg.getAppraisalByCert('PSA', cert);
    const tx = await reg.publish('PSA', cert, a.fmvLow, a.fmvPoint, a.fmvHigh, a.ltvBps, a.confidenceScore, a.compCount, a.confidence, a.risk, a.eligible);
    await tx.wait(); console.log('republished', cert, tx.hash);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
