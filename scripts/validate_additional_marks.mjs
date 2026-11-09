// Read-only public RPC ONLY. No Wallet, env, credentials, transaction sending,
// deployment, DB import, or public index writes. Outputs one private preparation.
import { ethers } from '/tmp/opencode/pub/node_modules/ethers/lib.esm/index.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
const root = new URL('../', import.meta.url);
const file = new URL('data/additional-mark-preparation.json', root);
const batch = JSON.parse(fs.readFileSync(file));
const abi = [
 'function publish(string,string,uint64,uint64,uint64,uint16,uint16,uint16,uint8,uint8,bool) returns(bytes32)',
 'function certKey(string,string) pure returns(bytes32)',
 'function exists(bytes32) view returns(bool)',
 'function ATTESTER_ROLE() view returns(bytes32)',
 'function hasRole(bytes32,address) view returns(bool)',
 'function getAppraisalByCert(string,string) view returns(tuple(uint64,uint64,uint64,uint16,uint16,uint16,uint8,uint8,bool,uint40,address))',
 'event AppraisalPublished(bytes32 indexed certKey,string grader,string certId,uint64 fmvLow,uint64 fmvPoint,uint64 fmvHigh,uint16 ltvBps,uint8 confidence,uint8 risk,bool eligible,address indexed attester)',
];
const provider = new ethers.JsonRpcProvider(batch.chain.rpc, undefined, {staticNetwork: true});
const registry = new ethers.Contract(batch.chain.registry, abi, provider);
const iface = new ethers.Interface(abi);
const coder = ethers.AbiCoder.defaultAbiCoder();
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const network = await provider.getNetwork();
if (Number(network.chainId) !== batch.chain.chain_id) throw Error('Wrong chain');
const block = await provider.getBlock('latest');
const pinned = block.number;
const at = new Date().toISOString();
const code = await provider.getCode(batch.chain.registry, pinned);
if (code === '0x') throw Error('Registry has no bytecode');
const existing = await registry.getAppraisalByCert('PSA', '109308847', {blockTag: pinned});
const attester = existing[10];
const role = await registry.ATTESTER_ROLE({blockTag: pinned});
if (!await registry.hasRole(role, attester, {blockTag: pinned})) throw Error('Existing attester lacks role');

// Exhaustive event history, bounded below RPC's ten-million-block range cap.
const topic = iface.getEvent('AppraisalPublished').topicHash;
const addresses = [batch.chain.registry, '0x30dfBCA3978CE186e6107A93cedC7d2971d30950'];
const logsByAddress = [];
for (const address of addresses) {
 const all = [];
 for (let start = 0; start <= pinned; start += 10000000) {
  const logs = await provider.getLogs({address, topics: [topic], fromBlock: start, toBlock: Math.min(start+9999999, pinned)});
  for (const log of logs) {
   const parsed = iface.parseLog(log);
   all.push({grader: parsed.args.grader, cert: parsed.args.certId, tx: log.transactionHash,
             block: log.blockNumber, log_index: log.index, removed: log.removed});
  }
 }
 logsByAddress.push({address, from_block: 0, through_block: pinned, events: all});
}
const issued = new Set(logsByAddress.flatMap(x => x.events.map(e => e.grader+':'+e.cert)));
const saved = new Set(batch.existing_identities);
const additionalIssued = [...issued].filter(x => !saved.has(x));
const feeData = await provider.getFeeData();
const simulations = [];
for (const record of batch.records) {
 const args = record.contract_proposal.args;
 const key = ethers.keccak256(coder.encode(['string', 'string'], args.slice(0, 2)));
 const actualKey = await registry.certKey(...args.slice(0, 2), {blockTag: pinned});
 if (key !== actualKey || issued.has(record.identity) || saved.has(record.identity)) throw Error('Identity duplicate or mismatch');
 if (await registry.exists(key, {blockTag: pinned})) throw Error('Certificate already exists');
 const data = iface.encodeFunctionData('publish', args);
 const decoded = iface.decodeFunctionData('publish', data);
 if (decoded[1] !== args[1] || Number(decoded[3]) !== args[3]) throw Error('ABI roundtrip failed');
 // eth_call impersonates ONLY a public from address for simulation, not signing.
 const request = {from: attester, to: batch.chain.registry, data, value: '0x0'};
 const returned = await provider.send('eth_call', [request, ethers.toQuantity(pinned)]);
 if (iface.decodeFunctionResult('publish', returned)[0] !== key) throw Error('Simulation certKey mismatch');
 const gas = BigInt(await provider.send('eth_estimateGas', [request, ethers.toQuantity(pinned)]));
 const gasPrice = feeData.gasPrice;
 record.contract_proposal.cert_key = key; // Contract key, explicitly NOT a tx hash.
 record.contract_proposal.unsigned_transaction = {chainId: batch.chain.chain_id, to: batch.chain.registry,
                                                data, value: '0', required_from: attester};
 simulations.push({identity: record.identity, cert_key_matches_registry: true, absent_onchain: true,
                   eth_call: 'passed', abi_roundtrip: 'passed', gas_estimate: gas.toString(),
                   gas_price_wei: gasPrice?.toString() ?? null,
                   execution_fee_at_fetched_gas_price_wei: gasPrice === null ? null : (gas*gasPrice).toString(),
                   fee_scope: 'RPC execution-gas estimate only; rollup data fees or wallet final quote may differ'});
}
batch.readonly_chain_validation = {checked_at: at, block: pinned, block_hash: block.hash,
 block_timestamp: new Date(block.timestamp*1000).toISOString(), chain_id: Number(network.chainId),
 runtime_bytecode_keccak256: ethers.keccak256(code), attester_public_address: attester,
 attester_role: role, attester_role_confirmed: true,
 signer_access: 'not_checked; no signing session established; no secret reads',
 complete_event_history: logsByAddress, distinct_issued_identities: [...issued].sort(),
 additional_existing_issued_identities: additionalIssued, simulations,
 actual_new_transactions_sent: 0,
 required_authorization: 'Use the wallet holding '+attester+' with ATTESTER_ROLE to approve exactly these six new-cert publish calls on Robinhood Chain testnet (46630); no keys in chat.',
 indexing_after_issue: 'Only after successful receipts: verify AppraisalPublished identity/bands, then populate mark_events from real receipts and enable the six public marks through the existing authenticated publisher. No database writes prepared as issuance evidence.',
};
for (const [path, hash] of Object.entries(batch.inputs_sha256)) {
 if (sha(fs.readFileSync(new URL(path, root))) !== hash) throw Error('Input changed: '+path);
}
if (new Set(batch.records.map(r => r.contract_proposal.cert_key)).size !== 6) throw Error('Duplicate contract keys');
fs.writeFileSync(file, JSON.stringify(batch, null, 2)+'\n');
console.log(JSON.stringify({prepared: batch.records.length, issued_distinct: issued.size,
 additional_existing_issued: additionalIssued, newly_issued: 0,
 simulated_successfully: simulations.length, block: pinned, attester,
 simulations}, null, 2));
