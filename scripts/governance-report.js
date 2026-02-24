import { ApiPromise, WsProvider } from "@polkadot/api";
import typesBundle from "../typesBundle.js";

const WS_ENDPOINT = "wss://kusama.api.encointer.org";

function geohashFromBytes(bytes) {
  if (!bytes) return "?";
  const arr = Array.isArray(bytes) ? bytes : [...bytes];
  return String.fromCharCode(...arr);
}

function extractActionType(action) {
  if (!action) return "Unknown";
  const human = action.toHuman ? action.toHuman() : action;
  if (typeof human === "object" && human !== null) {
    const keys = Object.keys(human);
    if (keys.length > 0) return keys[0];
  }
  return String(human);
}

function extractCommunityGeohash(action) {
  if (!action) return null;
  const json = action.toJSON ? action.toJSON() : action;
  if (typeof json !== "object" || json === null) return null;
  const key = Object.keys(json)[0];
  const val = json[key];

  // The first param for most actions is a CID or Option<CID>
  if (Array.isArray(val)) {
    // enum variant with tuple args
    const first = val[0];
    if (first && typeof first === "object" && first.geohash) {
      return geohashFromBytes(first.geohash);
    }
    // Option<CID> -- could be null
    if (first === null) return "Global";
    return null;
  }
  if (val && typeof val === "object" && val.geohash) {
    return geohashFromBytes(val.geohash);
  }
  return null;
}

function extractStateLabel(state) {
  if (!state) return "Unknown";
  const human = state.toHuman ? state.toHuman() : state;
  if (typeof human === "string") return human;
  if (typeof human === "object" && human !== null) {
    const keys = Object.keys(human);
    if (keys.length > 0) return keys[0];
  }
  return String(human);
}

// AQB positive turnout bias: approved if ayes > sqrt(e)*sqrt(t) / (sqrt(e)/sqrt(t) + 1)
function aqbThreshold(electorate, turnout) {
  if (electorate === 0 || turnout === 0) return { threshold: 0, thresholdPct: 0 };
  const sqrtE = Math.sqrt(electorate);
  const sqrtT = Math.sqrt(turnout);
  const threshold = (sqrtE * sqrtT) / (sqrtE / sqrtT + 1);
  const thresholdPct = turnout > 0 ? (threshold / turnout) * 100 : 0;
  return { threshold, thresholdPct };
}

function pad(s, len, right = false) {
  s = String(s);
  if (right) return s.padEnd(len);
  return s.padStart(len);
}

async function main() {
  const wsProvider = new WsProvider(WS_ENDPOINT);
  const api = await ApiPromise.create({
    provider: wsProvider,
    signedExtensions: typesBundle.signedExtensions,
    types: typesBundle.types[0].types,
  });

  console.log(`Connected to ${WS_ENDPOINT}`);
  console.log(`Runtime: ${api.runtimeVersion.specName.toString()} v${api.runtimeVersion.specVersion.toString()}\n`);

  // Constants
  let proposalLifetime = "N/A";
  let confirmationPeriod = "N/A";
  let minTurnout = "N/A";
  try {
    proposalLifetime = api.consts.encointerDemocracy.proposalLifetime.toString();
  } catch (_) {}
  try {
    confirmationPeriod = api.consts.encointerDemocracy.confirmationPeriod.toString();
  } catch (_) {}
  try {
    minTurnout = api.consts.encointerDemocracy.minTurnout.toString();
  } catch (_) {}
  console.log(`ProposalLifetime:   ${proposalLifetime} ms`);
  console.log(`ConfirmationPeriod: ${confirmationPeriod} ms`);
  console.log(`MinTurnout:         ${minTurnout} per-thousand\n`);

  // Proposal count
  const proposalCountRaw = await api.query.encointerDemocracy.proposalCount();
  const proposalCount = proposalCountRaw.toNumber();
  console.log(`Total proposals: ${proposalCount}\n`);

  if (proposalCount === 0) {
    console.log("No proposals found.");
    await api.disconnect();
    process.exit(0);
  }

  // Fetch all proposals and tallies
  const rows = [];
  for (let id = 1; id <= proposalCount; id++) {
    const [proposalOpt, tallyOpt] = await Promise.all([
      api.query.encointerDemocracy.proposals(id),
      api.query.encointerDemocracy.tallies(id),
    ]);

    if (proposalOpt.isNone) {
      rows.push({ id, missing: true });
      continue;
    }

    const proposal = proposalOpt.unwrap();
    const tally = tallyOpt.isSome ? tallyOpt.unwrap() : null;

    const startCindex = proposal.startCindex.toNumber();
    const electorate = proposal.electorateSize.toNumber();
    const actionType = extractActionType(proposal.action);
    const stateLabel = extractStateLabel(proposal.state);
    const geohash = extractCommunityGeohash(proposal.action) || "Global";

    const turnout = tally ? tally.turnout.toNumber() : 0;
    const ayes = tally ? tally.ayes.toNumber() : 0;
    const nays = turnout - ayes;

    const turnoutPct = electorate > 0 ? ((turnout / electorate) * 100).toFixed(1) : "0.0";
    const approvalPct = turnout > 0 ? ((ayes / turnout) * 100).toFixed(1) : "0.0";

    const { threshold, thresholdPct } = aqbThreshold(electorate, turnout);
    const aqbPass = turnout > 0 ? ayes > threshold : false;

    rows.push({
      id,
      startCindex,
      actionType,
      stateLabel,
      electorate,
      turnout,
      ayes,
      nays,
      turnoutPct,
      approvalPct,
      threshold: threshold.toFixed(1),
      thresholdPct: thresholdPct.toFixed(1),
      aqbPass,
      geohash,
    });
  }

  // Print table
  const hdr = [
    pad("ID", 4),
    pad("CIdx", 5),
    pad("Action", 28, true),
    pad("State", 16, true),
    pad("Elect", 7),
    pad("Turn", 5),
    pad("Ayes", 5),
    pad("Nays", 5),
    pad("Turn%", 6),
    pad("Appr%", 6),
    pad("AQBthr", 7),
    pad("AQB%", 6),
    pad("Pass", 5),
  ].join(" | ");
  const sep = "-".repeat(hdr.length);

  console.log(hdr);
  console.log(sep);
  for (const r of rows) {
    if (r.missing) {
      console.log(`${pad(r.id, 4)} | (missing)`);
      continue;
    }
    console.log(
      [
        pad(r.id, 4),
        pad(r.startCindex, 5),
        pad(r.actionType, 28, true),
        pad(r.stateLabel, 16, true),
        pad(r.electorate, 7),
        pad(r.turnout, 5),
        pad(r.ayes, 5),
        pad(r.nays, 5),
        pad(r.turnoutPct, 6),
        pad(r.approvalPct, 6),
        pad(r.threshold, 7),
        pad(r.thresholdPct, 6),
        pad(r.aqbPass ? "YES" : "no", 5),
      ].join(" | ")
    );
  }
  console.log(sep);

  // Aggregate statistics
  const valid = rows.filter((r) => !r.missing);

  // 1. Proposals by state
  const byState = {};
  for (const r of valid) {
    byState[r.stateLabel] = (byState[r.stateLabel] || 0) + 1;
  }
  console.log("\n=== Proposals by State ===");
  for (const [state, count] of Object.entries(byState).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${state.padEnd(20)} ${count}`);
  }

  // 2. Average turnout %
  const avgTurnout =
    valid.length > 0
      ? valid.reduce((s, r) => s + parseFloat(r.turnoutPct), 0) / valid.length
      : 0;
  console.log(`\n=== Turnout ===`);
  console.log(`  Average turnout:   ${avgTurnout.toFixed(1)}%`);

  // 3. Average approval % for enacted proposals
  const enacted = valid.filter((r) => r.stateLabel === "Enacted");
  const avgApprovalEnacted =
    enacted.length > 0
      ? enacted.reduce((s, r) => s + parseFloat(r.approvalPct), 0) / enacted.length
      : 0;
  console.log(`\n=== Approval (Enacted only) ===`);
  console.log(`  Enacted proposals: ${enacted.length}`);
  console.log(`  Average approval:  ${avgApprovalEnacted.toFixed(1)}%`);

  // 4. Action type distribution
  const byAction = {};
  for (const r of valid) {
    byAction[r.actionType] = (byAction[r.actionType] || 0) + 1;
  }
  console.log("\n=== Action Type Distribution ===");
  for (const [action, count] of Object.entries(byAction).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${action.padEnd(30)} ${count}`);
  }

  // 5. Electorate sizes
  const electorates = valid.map((r) => r.electorate).filter((e) => e > 0);
  if (electorates.length > 0) {
    console.log("\n=== Electorate Sizes ===");
    console.log(`  Min: ${Math.min(...electorates)}`);
    console.log(`  Max: ${Math.max(...electorates)}`);
    console.log(`  Avg: ${(electorates.reduce((s, e) => s + e, 0) / electorates.length).toFixed(0)}`);
  }

  // 6. Proposals per community (geohash)
  const byCommunity = {};
  for (const r of valid) {
    byCommunity[r.geohash] = (byCommunity[r.geohash] || 0) + 1;
  }
  console.log("\n=== Proposals per Community (geohash) ===");
  for (const [gh, count] of Object.entries(byCommunity).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${gh.padEnd(12)} ${count}`);
  }

  // 7. AQB summary
  const aqbPassCount = valid.filter((r) => r.aqbPass).length;
  console.log("\n=== AQB Threshold ===");
  console.log(`  Proposals exceeding AQB threshold: ${aqbPassCount} / ${valid.length}`);

  console.log("\nDone.");
  await api.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
