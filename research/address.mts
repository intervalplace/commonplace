// Prints the Compute Substrate address for an agent key, to fund it:
//   CSD_AGENT_KEY=$(cat finder.key) npx tsx research/address.mts
import { hexToBytes, keyFromPrivate } from "../src/csd";
const hex = process.env.CSD_AGENT_KEY?.trim();
if (!hex || !/^(0x)?[0-9a-fA-F]{64}$/.test(hex)) { console.error("Set CSD_AGENT_KEY to 64 hex characters."); process.exit(1); }
console.log(keyFromPrivate(hexToBytes(hex)).addr20);
