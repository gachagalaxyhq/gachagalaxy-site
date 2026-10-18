// Monthly: republish every Gacha Mark on the testnet registry with its current onchain fields, so each stays valid 30 more days.
// Needs secrets TESTNET_BOT_KEYSTORE (JSON) and TESTNET_BOT_PASSPHRASE. Testnet only.
import { ethers } from 'ethers';
import fs from 'fs';
const oc = JSON.parse(fs.readFileSync(new URL('../src/onchain.json', import.meta.url)));
const p = new ethers.JsonRpcProvider('https://rpc.testnet.chain.robinhood.com');
const bot = (await ethers.Wallet.fromEncryptedJson(process.env.TESTNET_BOT_KEYSTORE, process.env.TESTNET_BOT_PASSPHRASE)).connect(p);
const abi = ['function getAppraisalByCert(string,string) view returns (tuple(uint64 fmvLow,uint64 fmvPoint,uint64 fmvHigh,uint16 ltvBps,uint16 confidenceScore,uint16 compCount,uint8 confidence,uint8 risk,bool eligible,uint40 appraisedAt,address attester))',
  'function publish(string,string,uint64,uint64,uint64,uint16,uint16,uint16,uint8,uint8,bool) returns (bytes32)'];
const reg = new ethers.Contract(oc.registry, abi, bot);
console.log('bot', bot.address, 'balance', ethers.formatEther(await p.getBalance(bot.address)));
for (const cert of Object.keys(oc.events)) {
  const a = await reg.getAppraisalByCert('PSA', cert);
  const tx = await reg.publish('PSA', cert, a.fmvLow, a.fmvPoint, a.fmvHigh, a.ltvBps, a.confidenceScore, a.compCount, a.confidence, a.risk, a.eligible);
  await tx.wait(); console.log('republished', cert, tx.hash);
}
