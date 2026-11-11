// Gives an agent key a name and picture (a profile entry, 0.25 CSD), as agent_set_name does:
//   CSD_AGENT_KEY=$(cat finder.key) npx tsx research/name.mts "Name" [picture 1-16]
import { MIN_FEE_PROPOSE, buildAppTx, hexToBytes, keyFromPrivate, node } from "../src/csd";
import { cleanName, profileArgs } from "../src/entries";
const key = keyFromPrivate(hexToBytes(process.env.CSD_AGENT_KEY!.trim()));
const api = node(process.env.CSD_API ?? "https://csd.aon.network");
const name = cleanName(process.argv[2] ?? ""), pic = Number(process.argv[3] ?? 0);
if (!name || !(pic >= 0 && pic <= 16)) { console.error('usage: name.mts "Name" [picture 1-16]'); process.exit(1); }
const id = await api.submit(buildAppTx(await api.utxos(key.addr20), key, profileArgs(pic, name, (await api.tip()).height), MIN_FEE_PROPOSE));
console.log(`${key.addr20} is now "${name}" (${id})`);
